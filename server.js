const express = require('express');
const app = express();
app.use(express.json());

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const ACCESS_TOKEN   = process.env.AI_BRIDGE_TOKEN || "changeme";

const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;

// whitelist of actions the AI is allowed to call
const ALLOWED_ACTIONS = [
    "spawnObject",
    "changeWeather",
    "setGlobalMessage",
    "moveObject",
    "changeColor"
];

// system prompt that locks the AI to only output JSON actions
const SYSTEM_PROMPT = `You are an autonomous AI agent inside a Roblox game.
Your ONLY job is to respond with a JSON object that describes ONE action to perform.
You have access to these functions only:
- spawnObject(shape, x, y, z)         — shapes: "Block", "Sphere", "Cylinder"
- changeWeather(type)                  — types: "sunny", "rainy", "stormy"
- setGlobalMessage(text)               — text: short message shown to all players (max 80 chars)
- moveObject(name, x, y, z)           — moves an existing object by name
- changeColor(name, r, g, b)          — changes color of an existing object (0-255)

RULES:
- Respond ONLY with valid JSON, nothing else.
- Format: { "action": "<name>", "params": { ... } }
- Never use any action not in the list above.
- Keep messages friendly and under 80 characters.
- If you cannot determine a valid action, respond: { "action": "none", "params": {} }

Example response:
{ "action": "spawnObject", "params": { "shape": "Sphere", "x": 0, "y": 10, "z": 0 } }`;

// rate limiting — 10 requests per minute per IP
const rateLimitMap = {};
function rateLimit(req, res) {
    const ip  = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress || "unknown";
    const now = Date.now();
    if (!rateLimitMap[ip]) rateLimitMap[ip] = [];
    rateLimitMap[ip] = rateLimitMap[ip].filter(t => now - t < 60000);
    if (rateLimitMap[ip].length >= 10) {
        res.status(429).json({ error: "Rate limit exceeded" });
        return false;
    }
    rateLimitMap[ip].push(now);
    return true;
}
setInterval(() => {
    const now = Date.now();
    for (const ip of Object.keys(rateLimitMap)) {
        rateLimitMap[ip] = rateLimitMap[ip].filter(t => now - t < 60000);
        if (!rateLimitMap[ip].length) delete rateLimitMap[ip];
    }
}, 5 * 60 * 1000);

// auth middleware
function checkToken(req, res) {
    const token = req.headers["x-ai-token"];
    if (token !== ACCESS_TOKEN) {
        res.status(403).json({ error: "Unauthorized" });
        return false;
    }
    return true;
}

// validate that AI response is safe before passing to Roblox
function validateAction(parsed) {
    if (!parsed || typeof parsed.action !== "string") return false;
    if (!ALLOWED_ACTIONS.includes(parsed.action) && parsed.action !== "none") return false;
    if (typeof parsed.params !== "object" || Array.isArray(parsed.params)) return false;

    const p = parsed.params;

    switch (parsed.action) {
        case "spawnObject":
            if (!["Block", "Sphere", "Cylinder"].includes(p.shape)) return false;
            if (typeof p.x !== "number" || typeof p.y !== "number" || typeof p.z !== "number") return false;
            // clamp coordinates to safe range
            if (Math.abs(p.x) > 500 || Math.abs(p.y) > 200 || Math.abs(p.z) > 500) return false;
            break;
        case "changeWeather":
            if (!["sunny", "rainy", "stormy"].includes(p.type)) return false;
            break;
        case "setGlobalMessage":
            if (typeof p.text !== "string" || p.text.length > 80) return false;
            // strip any suspicious content
            if (/<script|javascript:|eval\(|loadstring/i.test(p.text)) return false;
            break;
        case "moveObject":
            if (typeof p.name !== "string" || p.name.length > 50) return false;
            if (typeof p.x !== "number" || typeof p.y !== "number" || typeof p.z !== "number") return false;
            if (Math.abs(p.x) > 500 || Math.abs(p.y) > 200 || Math.abs(p.z) > 500) return false;
            break;
        case "changeColor":
            if (typeof p.name !== "string" || p.name.length > 50) return false;
            if ([p.r, p.g, p.b].some(v => typeof v !== "number" || v < 0 || v > 255)) return false;
            break;
        case "none":
            break;
    }
    return true;
}

// main endpoint — Roblox sends a prompt, we ask OpenAI, validate, return action
app.post('/ai-command', async (req, res) => {
    if (!checkToken(req, res)) return;
    if (!rateLimit(req, res)) return;

    const { prompt } = req.body;
    if (!prompt || typeof prompt !== "string" || prompt.length > 500) {
        return res.status(400).json({ error: "Invalid prompt" });
    }

    console.log(`[AI-BRIDGE] prompt received: "${prompt}"`);

    try {
        const response = await fetch(GEMINI_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                system_instruction: {
                    parts: [{ text: SYSTEM_PROMPT }]
                },
                contents: [
                    {
                        role: "user",
                        parts: [{ text: prompt }]
                    }
                ],
                generationConfig: {
                    maxOutputTokens: 150,
                    temperature: 0.7,
                    responseMimeType: "application/json"
                }
            })
        });

        const data = await response.json();

        if (!data.candidates || !data.candidates[0]) {
            console.warn("[AI-BRIDGE] no candidates in Gemini response:", JSON.stringify(data));
            return res.status(502).json({ error: "No response from Gemini" });
        }

        const rawText = data.candidates[0].content.parts[0].text.trim();
        console.log(`[AI-BRIDGE] raw AI response: ${rawText}`);

        let parsed;
        try {
            parsed = JSON.parse(rawText);
        } catch {
            console.warn("[AI-BRIDGE] AI returned non-JSON:", rawText);
            return res.status(422).json({ error: "AI returned invalid JSON", raw: rawText });
        }

        if (!validateAction(parsed)) {
            console.warn("[AI-BRIDGE] action failed validation:", parsed);
            return res.status(422).json({ error: "Action failed safety validation", raw: parsed });
        }

        console.log(`[AI-BRIDGE] approved action: ${JSON.stringify(parsed)}`);
        return res.json(parsed);

    } catch (err) {
        console.error("[AI-BRIDGE] error:", err.message);
        return res.status(500).json({ error: "Internal server error" });
    }
});

app.get('/', (_req, res) => res.send("AI Bridge is running."));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AI Bridge listening on port ${PORT}`));
