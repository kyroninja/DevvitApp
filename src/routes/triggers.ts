import { Hono } from 'hono';
import type {
  OnAppInstallRequest,
  TriggerResponse,
} from '@devvit/web/shared';

import { reddit, redis } from '@devvit/web/server';

import type { T1 } from '@devvit/shared-types/tid.js';
import { isT1 } from '@devvit/shared-types/tid.js';

const PYTHON_WEBHOOK = "https://reddit.kyro.ninja/webhook/devvit";
const SECRET = "5@shade@rR";

async function pushToPython(data: any) {
  try {
    await fetch(PYTHON_WEBHOOK, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SECRET}`,
      },
      body: JSON.stringify(data),
    });
  } catch (err) {
    console.error("[python webhook failed]", err);
  }
}

export const triggers = new Hono();

/* ─────────────────────────────────────────────
   PYTHON BRIDGE AUTH
───────────────────────────────────────────── */

const PYTHON_BRIDGE_SECRET = '5@shade@rR';

/* ─────────────────────────────────────────────
   ERROR HANDLER
───────────────────────────────────────────── */

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* ─────────────────────────────────────────────
   STORAGE + QUEUE (DEVVIT SAFE)
───────────────────────────────────────────── */

async function savePost(data: Record<string, unknown>): Promise<void> {
  try {
    if (!data.id) return;

    const key = `post:${data.id}`;
    await redis.set(key, JSON.stringify(data));

    // 🔁 SAFE QUEUE IMPLEMENTATION (NO LISTS)
    const indexKey = 'queue:posts:index';
    const current = await redis.get(indexKey);
    const nextIndex = current ? Number(current) + 1 : 0;

    await redis.set(`queue:posts:${nextIndex}`, String(data.id));
    await redis.set(indexKey, String(nextIndex));

    console.log(`[savePost] cached + queued ${key} @ ${nextIndex}`);
  } catch (err) {
    console.error('[savePost] failed:', getErrorMessage(err));
  }
}

async function saveComments(
  comments: Record<string, unknown>[]
): Promise<void> {
  try {
    for (const comment of comments) {
      if (!comment.id) continue;

      await redis.set(
        `comment:${comment.id}`,
        JSON.stringify(comment)
      );
    }

    console.log(`[saveComments] cached ${comments.length}`);
  } catch (err) {
    console.error('[saveComments] failed:', getErrorMessage(err));
  }
}

/* ─────────────────────────────────────────────
   PYTHON BRIDGE: FETCH POST
───────────────────────────────────────────── */

triggers.get('/bridge/post/:id', async (c) => {
  try {
    const auth =
  c.req.header('authorization') ||
  c.req.header('Authorization');

    if (auth !== `Bearer ${PYTHON_BRIDGE_SECRET}`) {
      return c.json({ error: 'unauthorized' }, 401);
    }

    const id = c.req.param('id');
    const data = await redis.get(`post:${id}`);

    if (!data) {
      return c.json({ error: 'not found' }, 404);
    }

    return c.json(JSON.parse(data), 200);
  } catch (err) {
    return c.json({ error: getErrorMessage(err) }, 500);
  }
});

/* ─────────────────────────────────────────────
   PYTHON BRIDGE: QUEUE NEXT (FIXED)
───────────────────────────────────────────── */

triggers.post('/bridge/queue/next', async (c) => {
  try {
    const auth = c.req.header('Authorization');

    if (auth !== `Bearer ${PYTHON_BRIDGE_SECRET}`) {
      return c.json({ error: 'unauthorized' }, 401);
    }

    const indexKey = 'queue:posts:index';
    const current = await redis.get(indexKey);

    if (!current) {
      return c.json({ id: null }, 200);
    }

    const id = await redis.get(`queue:posts:${current}`);

    return c.json({ id: id ?? null }, 200);
  } catch (err) {
    return c.json({ error: getErrorMessage(err) }, 500);
  }
});

/* ─────────────────────────────────────────────
   ANALYSIS ENGINE
───────────────────────────────────────────── */

type AnalysisResult = {
  decision: 'ALLOW' | 'FLAG' | 'MODERATE' | 'DELETE';
  score: number;
  reason_text: string;
};

async function analyzeEntity(entityId: string): Promise<AnalysisResult> {
  const score = Math.floor(Math.random() * 100);

  if (score > 75)
    return { decision: 'DELETE', score, reason_text: 'high risk' };

  if (score > 50)
    return { decision: 'MODERATE', score, reason_text: 'review' };

  if (score > 30)
    return { decision: 'FLAG', score, reason_text: 'borderline' };

  return { decision: 'ALLOW', score, reason_text: 'safe' };
}

/* ─────────────────────────────────────────────
   POST CREATE
───────────────────────────────────────────── */

triggers.post('/on-post-create', async (c) => {
  const input = await c.req.json().catch(() => null);
  const post = input?.post ?? input;

  if (!post?.id) return c.json({ status: "ok" });

  await pushToPython({
    type: "post",
    id: post.id,
    title: post.title,
    author: post.author,
    subreddit: post.subreddit,
    content: post.selftext,
    created_at: Date.now()
  });

  return c.json({ status: "ok" });
});

/* ─────────────────────────────────────────────
   COMMENT CREATE (UNCHANGED)
───────────────────────────────────────────── */

triggers.post('/on-comment-create', async (c) => {
  try {
    const input = await c.req.json().catch(() => null);
    const comment = input?.comment ?? input;

    if (!comment?.id) {
      return c.json({ status: 'success' }, 200);
    }

    await saveComments([
      {
        id: comment.id,
        post_id: comment.postId ?? '',
        parent_id: comment.parentId ?? '',
        author: comment.author ?? '',
        content: comment.body ?? '',
        score: comment.score ?? 0,
        created_at: new Date().toISOString(),
      },
    ]);

    const analysis = await analyzeEntity(comment.id);

    if (analysis.decision !== 'ALLOW') {
      const rawId = `t1_${comment.id}`;

      if (isT1(rawId as T1)) {
        const commentObj = await reddit.getCommentById(rawId as T1);

        if (analysis.decision === 'DELETE' && !commentObj.removed) {
          await commentObj.remove();
        }

        if (
          (analysis.decision === 'MODERATE' ||
            analysis.decision === 'FLAG') &&
          !commentObj.locked
        ) {
          await commentObj.lock();
        }
      }
    }

    return c.json({ status: 'success' }, 200);
  } catch (err) {
    console.error('[on-comment-create]', getErrorMessage(err));
    return c.json({ status: 'success' }, 200);
  }
});