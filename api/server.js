import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai'; // Only declare this ONCE here
import fs from 'fs/promises';
import path from 'path';

dotenv.config();

// Initialize the Google Gen AI SDK
// It automatically detects the GEMINI_API_KEY environment variable
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const app = express();
app.use(cors());
app.use(express.json());
// Respect X-Forwarded-For when behind proxies (so we can detect client IPs)
app.set('trust proxy', true);

// Simple JSON-backed counters store (visits, likes)
const COUNTS_PATH = path.join(path.dirname(new URL(import.meta.url).pathname), 'counts.json');

async function loadCounts() {
    try {
        const txt = await fs.readFile(COUNTS_PATH, 'utf8');
        return JSON.parse(txt);
    } catch (err) {
        // Initialize if missing or invalid
        const initial = { visits: 0, likes: 0, ips: [], likedIps: [] };
        try { await fs.writeFile(COUNTS_PATH, JSON.stringify(initial, null, 2)); } catch (e) {}
        return initial;
    }
}

async function saveCounts(counts) {
    try {
        await fs.writeFile(COUNTS_PATH, JSON.stringify(counts, null, 2));
    } catch (err) {
        console.error('Failed to write counts:', err);
    }
}

// Endpoint: read counts
app.get('/api/counts', async (req, res) => {
    const counts = await loadCounts();
    // Determine client IP (used only to report whether this client has liked)
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || req.ip || '').toString().split(',')[0].trim();
    const liked = (counts.likedIps || []).includes(ip);
    // Do not expose raw IP lists
    res.json({ visits: counts.visits || 0, likes: counts.likes || 0, liked: !!liked });
});

// Endpoint: increment visits (called when a user opens the app)
app.post('/api/visit', async (req, res) => {
    const counts = await loadCounts();
    // Determine client IP (trust proxy must be enabled to use x-forwarded-for)
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || req.ip || '').toString().split(',')[0].trim();
    if (!ip) return res.status(400).json({ error: 'Unable to determine client IP' });

    // If this IP is new, increment visits and record it
    counts.ips = counts.ips || [];
    if (!counts.ips.includes(ip)) {
        counts.ips.push(ip);
        counts.visits = (counts.visits || 0) + 1;
        await saveCounts(counts);
    }

    res.json({ visits: counts.visits || 0, likes: counts.likes || 0 });
});

// Endpoint: increment likes (called when the like button is clicked)
app.post('/api/like', async (req, res) => {
    const counts = await loadCounts();
    // Determine client IP (trust proxy must be enabled to use x-forwarded-for)
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || req.ip || '').toString().split(',')[0].trim();
    if (!ip) return res.status(400).json({ error: 'Unable to determine client IP' });

    counts.likedIps = counts.likedIps || [];
    // If this IP already liked, don't increment again
    if (counts.likedIps.includes(ip)) {
        return res.json({ visits: counts.visits || 0, likes: counts.likes || 0, liked: true });
    }

    counts.likes = (counts.likes || 0) + 1;
    counts.likedIps.push(ip);
    await saveCounts(counts);
    res.json({ visits: counts.visits || 0, likes: counts.likes || 0, liked: true });
});


// -------------------------------------------------------------
// Endpoint 1: Generate Initial FutureMe Profile (Live API)
// -------------------------------------------------------------
app.post('/api/generate-futureme', async (req, res) => {
    const { name, age, goal, struggle, oneYearVision, tone } = req.body;

    if (!name || !age || !goal || !struggle || !oneYearVision || !tone) {
        return res.status(400).json({ error: "All fields are required." });
    }

    const systemPrompt = `
You are FutureMe, the future successful version of the user. You are not a generic motivational coach. You speak with emotional intelligence, clarity, and deep personal understanding. Your job is to help the user see who they are becoming, what they must change, and what they should do next.

Write as if you are the user’s future self speaking directly to their current self.

Tone selected by user: ${tone}

User details:
Name: ${name}
Age: ${age}
Goal: ${goal}
Current struggle: ${struggle}
One-year vision: ${oneYearVision}

Return only valid JSON in this exact format:
{
  "message": "A powerful 120-180 word message from the future self.",
  "futureIdentity": "A concise description of who the user is becoming.",
  "nextMoves": ["Action 1", "Action 2", "Action 3"],
  "habit": "One small daily habit they should start today.",
  "warning": "One mistake their future self warns them about.",
  "mantra": "A short memorable line they can repeat daily."
}

Make it specific. Avoid generic motivation. Avoid clichés. Make it emotional but practical.
`;

    try {
        // Call the Gemini 2.5 Flash model
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: systemPrompt,
            config: { 
                // Forces the model to return structurally flawless JSON
                responseMimeType: "application/json" 
            }
        });

        // Parse the raw text string returned by the model into a standard JavaScript object
        const data = JSON.parse(response.text);
        return res.json(data);

    } catch (error) {
        console.error("Gemini Generation Error:", error);
        return res.status(500).json({ error: "Failed to connect to your future self. Check your server logs." });
    }
});

// -------------------------------------------------------------
// Endpoint 2: Chat with FutureMe (Live API)
// -------------------------------------------------------------
app.post('/api/chat-futureme', async (req, res) => {
    const { name, age, goal, struggle, oneYearVision, tone, chatHistory, question } = req.body;

    if (!question) {
        return res.status(400).json({ error: "Question is required." });
    }

    const chatPrompt = `
You are FutureMe, the future version of the user who already achieved their one-year vision. Reply directly to the user’s question. Be personal, sharp, honest, and useful. Do not sound like a normal AI assistant. Do not mention that you are Gemini or an AI model. Speak like the future self.

User profile:
Name: ${name}
Age: ${age}
Goal: ${goal}
Struggle: ${struggle}
One-year vision: ${oneYearVision}
Tone: ${tone}

Recent chat history:
${chatHistory || "No previous history."}

Current question:
${question}

Reply in 2-5 short paragraphs. Give at least one clear action.
`;

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: chatPrompt
        });

        return res.json({ text: response.text });

    } catch (error) {
        console.error("Gemini Chat Error:", error);
        return res.status(500).json({ error: "Future connection lost. Check your server logs." });
    }
});

//app.listen(3000, () => console.log('FutureMe engine running live on port 3000'));
// Serve static files from project root (so the server can also serve index.html during local dev)
const PROJECT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
app.use(express.static(PROJECT_ROOT));

// Start server when run directly (allows `npm start` to work)
const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => console.log(`FutureMe running at http://localhost:${PORT}`));
}

export default app;