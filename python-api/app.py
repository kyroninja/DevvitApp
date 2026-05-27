from flask import Flask, request, jsonify
from flask_cors import CORS
import psycopg2
from psycopg2.extras import RealDictCursor
import os
from dotenv import load_dotenv
import nltk
from nltk.sentiment import SentimentIntensityAnalyzer
import requests


load_dotenv()

app = Flask(__name__)
CORS(app)

# Download once on startup (safe to call repeatedly)
#nltk.download("vader_lexicon")
_SIA = SentimentIntensityAnalyzer()

# Toxic keyword list — extend as needed
_TOXIC_KEYWORDS = [
    "kill", "die", "hate", "idiot", "moron", "stupid", "racist",
    "slur", "kys", "suicide", "bomb", "attack", "terrorist",
]


def _risk_score(text: str) -> tuple[float, float]:
    """Returns (risk_0_to_100, sentiment_compound)."""
    if not text or not text.strip():
        return 0.0, 0.0

    words = text.lower().split()
    word_count = max(len(words), 1)

    sentiment = _SIA.polarity_scores(text)["compound"]  # -1 to 1

    # keyword hit ratio
    hits = sum(1 for w in words if any(kw in w for kw in _TOXIC_KEYWORDS))
    keyword_ratio = hits / word_count

    # negativity weight
    negativity = max(-sentiment, 0)  # 0 when positive, up to 1 when very negative

    # combined score (0–100)
    score = min(100.0, (keyword_ratio * 60 + negativity * 40) * 100)

    return round(score, 2), round(sentiment, 4)

def fetch_cached_post(post_id):
    # Your Devvit deployment endpoint base URL
    url = f"https://bigbirdiesings12.devvit.apps.reddit.com/internal/triggers/bridge/post/{post_id}"
   
    headers = {
        "Authorization": "Bearer SUPER_SECRET_TOKEN_123_ABC",
        "Content-Type": "application/json"
    }
   
    response = requests.get(url, headers=headers)
   
    if response.status_code == 200:
        return response.json() # Returns your post object data
    else:
        print(f"Error: {response.status_code} - {response.text}")
        return None

# ======================================================
# DATABASE
# ======================================================

def get_db_connection():
    return psycopg2.connect(
        host="localhost",
        port=5432,
        database=os.getenv("DB_NAME"),
        user=os.getenv("DB_USER"),
        password=os.getenv("DB_PASSWORD")
    )


# ======================================================
# POSTS
# ======================================================

@app.route('/posts', methods=['POST'])
def save_post():
    try:
        data = request.get_json()

        conn = get_db_connection()
        cur = conn.cursor()

        cur.execute("""
            INSERT INTO posts (
                id,
                reddit_author,
                subreddit,
                title,
                content,
                url,
                language,
                location,
                views,
                likes,
                downvotes,
                created_at
            )
            VALUES (
                %s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s
            )
            ON CONFLICT (id)
            DO UPDATE SET
                title = EXCLUDED.title,
                content = EXCLUDED.content,
                likes = EXCLUDED.likes,
                downvotes = EXCLUDED.downvotes
        """, (
            data['id'],
            data.get('reddit_author'),
            data['subreddit'],
            data.get('title'),
            data.get('content'),
            data.get('url'),
            data.get('language'),
            data.get('location'),
            data.get('views', 0),
            data.get('likes', 0),
            data.get('downvotes', 0),
            data['created_at']
        ))

        conn.commit()
        cur.close()
        conn.close()

        return jsonify({
            "success": True,
            "entity": "post",
            "id": data['id']
        }), 201

    except Exception as e:
        return jsonify({
            "success": False,
            "error": str(e)
        }), 500


# ======================================================
# COMMENTS
# ======================================================

@app.route('/comments', methods=['POST'])
def save_comments():
    try:
        comments = request.get_json()

        conn = get_db_connection()
        cur = conn.cursor()

        for c in comments:
            cur.execute("""
                INSERT INTO comments (
                    id,
                    post_id,
                    parent_id,
                    reddit_author,
                    content,
                    views,
                    likes,
                    downvotes,
                    created_at
                )
                VALUES (
                    %s,%s,%s,%s,%s,%s,%s,%s,%s
                )
                ON CONFLICT (id)
                DO UPDATE SET
                    content = EXCLUDED.content,
                    likes = EXCLUDED.likes,
                    downvotes = EXCLUDED.downvotes
            """, (
                c['id'],
                c['post_id'],
                c.get('parent_id'),
                c.get('reddit_author'),
                c.get('content'),
                c.get('views', 0),
                c.get('likes', 0),
                c.get('downvotes', 0),
                c['created_at']
            ))

        conn.commit()
        cur.close()
        conn.close()

        return jsonify({
            "success": True,
            "count": len(comments)
        }), 201

    except Exception as e:
        return jsonify({
            "success": False,
            "error": str(e)
        }), 500


# ======================================================
# HEALTH CHECK
# ======================================================

@app.route('/health', methods=['GET'])
def health():
    return jsonify({
        "status": "healthy"
    })


# ======================================================
# ANALYZE
# ======================================================

@app.route('/analyze', methods=['POST'])
def analyze():
    data = request.get_json(force=True)
    entity_id = data.get('entity_id', '').strip()
    entity_type = data.get('entity_type', 'comment')

    if not entity_id:
        return jsonify({"error": "entity_id required"}), 400

    try:
        conn = get_db_connection()
        cur = conn.cursor(cursor_factory=RealDictCursor)

        table = "comments" if entity_type == "comment" else "posts"
        cur.execute(f"SELECT content FROM {table} WHERE id = %s", (entity_id,))
        row = cur.fetchone()

        if not row:
            return jsonify({
                "decision": "ALLOW",
                "score": 0,
                "reason_text": "Entity not found in DB"
            }), 200

        text = row["content"] or ""
        score, sentiment = _risk_score(text)

        # Thresholds — tweak freely
        if score >= 60:
            decision = "DELETE"
        elif score >= 30:
            decision = "MODERATE"
        else:
            decision = "ALLOW"

        reason = f"Risk score: {score:.1f} | Sentiment: {sentiment:.2f}"

        # Write to moderated table
        cur.execute("""
            INSERT INTO moderated
            (entity_id, entity_type, decision, agent_type, score, reason_text)
            VALUES (%s, %s, %s, 'AUTO', %s, %s)
        """, (entity_id, entity_type, decision, score, reason))

        conn.commit()
        cur.close()
        conn.close()

        return jsonify({
            "decision": decision,
            "score": score,
            "sentiment": sentiment,
            "reason_text": reason,
        }), 200

    except Exception as e:
        return jsonify({"error": str(e)}), 500


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=3005, debug=True)
