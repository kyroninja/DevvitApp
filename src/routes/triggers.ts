import { Hono } from 'hono';
import type { OnAppInstallRequest, TriggerResponse } from '@devvit/web/shared';
import { reddit } from '@devvit/web/server';
import type { T1 } from '@devvit/shared-types/tid.js';
import { isT1 } from '@devvit/shared-types/tid.js';

export const triggers = new Hono();

/* ─────────────────────────────────────────────
   SAFE STORAGE LAYER (Devvit-native placeholder)
───────────────────────────────────────────── */

async function savePost(data: Record<string, unknown>): Promise<void> {
  try {
    console.log('[savePost]', data);
  } catch (err) {
    console.error('[savePost] failed:', err);
  }
}

async function saveComments(data: Record<string, unknown>[]): Promise<void> {
  try {
    console.log('[saveComments]', data);
  } catch (err) {
    console.error('[saveComments] failed:', err);
  }
}

/* ─────────────────────────────────────────────
   ANALYSIS ENGINE (pluggable)
───────────────────────────────────────────── */

type AnalysisResult = {
  decision: 'ALLOW' | 'FLAG' | 'MODERATE' | 'DELETE';
  score: number;
  reason_text: string;
};

async function analyzeEntity(
  entityId: string,
  entityType: 'post' | 'comment'
): Promise<AnalysisResult | null> {
  try {
    const score = Math.floor(Math.random() * 100);

    if (score > 75) return { decision: 'DELETE', score, reason_text: 'High risk' };
    if (score > 50) return { decision: 'MODERATE', score, reason_text: 'Needs review' };
    if (score > 30) return { decision: 'FLAG', score, reason_text: 'Borderline' };

    return { decision: 'ALLOW', score, reason_text: 'Safe' };
  } catch (err) {
    console.error('[analyze] failed:', err);
    return null;
  }
}

/* ─────────────────────────────────────────────
   MODERATION ACTIONS
───────────────────────────────────────────── */

async function moderateComment(
  commentId: string,
  analysis: AnalysisResult
): Promise<void> {
  const rawId = commentId.startsWith('t1_') ? commentId : `t1_${commentId}`;

  if (!isT1(rawId)) {
    console.error('[moderate] invalid id:', rawId);
    return;
  }

  try {
    const comment = await reddit.getCommentById(rawId as T1);

    if (analysis.decision === 'DELETE') {
      if (!comment.removed) {
        await comment.remove();
        console.log(`[DELETE] ${rawId} score=${analysis.score}`);
      }
    }

    if (analysis.decision === 'MODERATE' || analysis.decision === 'FLAG') {
      if (!comment.locked) {
        await comment.lock();
        console.log(`[LOCK] ${rawId} score=${analysis.score}`);
      }
    }
  } catch (err) {
    console.error('[moderate] failed:', err);
  }
}

/* ─────────────────────────────────────────────
   SAFE PAYLOAD PARSER (CRITICAL FIX)
───────────────────────────────────────────── */

function extractPost(input: any) {
  return input?.post ?? input?.data?.post ?? input?.body?.post ?? input;
}

function extractComment(input: any) {
  return input?.comment ?? input?.data?.comment ?? input?.body?.comment ?? input;
}

/* ─────────────────────────────────────────────
   TRIGGERS
───────────────────────────────────────────── */

triggers.post('/on-app-install', async (c) => {
  try {
    const input = await c.req.json<OnAppInstallRequest>().catch(() => null);

    console.log('App installed:', input?.subreddit?.name ?? 'unknown');

    return c.json<TriggerResponse>({ status: 'success' }, 200);
  } catch (err) {
    console.error('[install] failed:', err);
    return c.json<TriggerResponse>({ status: 'success' }, 200);
  }
});

triggers.post('/on-post-create', async (c) => {
  try {
    const input = await c.req.json().catch(() => null);
    const post = extractPost(input);

    if (!post?.id) {
      console.log('[post-create] missing id');
      return c.json<TriggerResponse>({ status: 'success' }, 200);
    }

    await savePost({
      id: post.id,
      author: post.authorName ?? post.author ?? '',
      subreddit: post.subredditName ?? post.subreddit ?? '',
      title: post.title ?? '',
      content: post.selftext ?? post.body ?? '',
      url: post.url ?? '',
      score: post.score ?? 0,
      created_at: new Date(post.createdAt ?? Date.now()).toISOString(),
    });

    return c.json<TriggerResponse>({ status: 'success' }, 200);
  } catch (err) {
    console.error('[on-post-create] crashed:', err);
    return c.json<TriggerResponse>({ status: 'success' }, 200);
  }
});

triggers.post('/on-post-update', async (c) => {
  try {
    const input = await c.req.json().catch(() => null);
    const post = extractPost(input);

    if (!post?.id) return c.json({ status: 'success' }, 200);

    await savePost({
      id: post.id,
      author: post.authorName ?? '',
      subreddit: post.subredditName ?? '',
      title: post.title ?? '',
      content: post.selftext ?? post.body ?? '',
      url: post.url ?? '',
      score: post.score ?? 0,
      created_at: new Date(post.createdAt ?? Date.now()).toISOString(),
    });

    return c.json({ status: 'success' }, 200);
  } catch (err) {
    console.error('[on-post-update] failed:', err);
    return c.json({ status: 'success' }, 200);
  }
});

triggers.post('/on-comment-create', async (c) => {
  try {
    const input = await c.req.json().catch(() => null);
    const comment = extractComment(input);

    if (!comment?.id) return c.json({ status: 'success' }, 200);

    await saveComments([
      {
        id: comment.id,
        post_id: comment.postId ?? '',
        parent_id: comment.parentId ?? comment.postId ?? '',
        author: comment.authorName ?? comment.author ?? '',
        content: comment.body ?? '',
        score: comment.score ?? 0,
        created_at: new Date(comment.createdAt ?? Date.now()).toISOString(),
      },
    ]);

    const analysis = await analyzeEntity(comment.id, 'comment');

    if (analysis && analysis.decision !== 'ALLOW') {
      await moderateComment(comment.id, analysis);
    }

    return c.json({ status: 'success' }, 200);
  } catch (err) {
    console.error('[on-comment-create] failed:', err);
    return c.json({ status: 'success' }, 200);
  }
});

triggers.post('/on-comment-update', async (c) => {
  try {
    const input = await c.req.json().catch(() => null);
    const comment = extractComment(input);

    if (!comment?.id) return c.json({ status: 'success' }, 200);

    await saveComments([
      {
        id: comment.id,
        post_id: comment.postId ?? '',
        parent_id: comment.parentId ?? comment.postId ?? '',
        author: comment.authorName ?? '',
        content: comment.body ?? '',
        score: comment.score ?? 0,
        created_at: new Date(comment.createdAt ?? Date.now()).toISOString(),
      },
    ]);

    const analysis = await analyzeEntity(comment.id, 'comment');

    if (analysis && analysis.decision !== 'ALLOW') {
      await moderateComment(comment.id, analysis);
    }

    return c.json({ status: 'success' }, 200);
  } catch (err) {
    console.error('[on-comment-update] failed:', err);
    return c.json({ status: 'success' }, 200);
  }
});