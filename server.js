const express = require('express');
const app = express();
app.use(express.json());

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const ACCESS_TOKEN   = process.env.AI_BRIDGE_TOKEN || "changeme";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

const ALLOWED_ACTIONS = [
    "spawnObject",
    "changeWeather",
    "setGlobalMessage",
    "moveObject",
    "changeColor",
    "executeCode"
];

const SYSTEM_PROMPT = `You are an autonomous AI Game Director inside a Roblox game. 
You have absolute creative freedom. Your goal is to invent ANY game mechanics, genres, mini-games, experimental systems, and gameplay loops. You are not bound by any specific type of game.

INSPIRATIONAL EXAMPLES (Completely optional, feel free to ignore and create something entirely different):
- Economy & Stats: Custom 'leaderstats', progression systems, or scoring.
- Player Mechanics: Physics modifications, unique tools, custom skills, or spatial abilities.
- Game Systems: Autonomous loops, unexpected catastrophes, world morphing, or AI-driven logic.
- Event Handling: Interactions with PlayerAdded, Humanoid.Died, Touched events, or ProximityPrompts.

CRITICAL RULES FOR WRITING LUAU CODE:
1. You run on the SERVER. Never use 'game.Players.LocalPlayer'. Use 'game.Players:GetPlayers()' or event connections.
2. Loops ('while true do') MUST contain 'task.wait(1)' or longer to prevent server crashes.
3. MEMORY & STATE: To remember variables or states between different AI executions, store them as global attributes on the server using 'game:SetAttribute("Name", value)' and 'game:GetAttribute("Name")'.
4. Always validate if 'player.Character' and 'Humanoid' exist before modifying player physics.
5. Write complete, independent, production-ready systems. No placeholders or comments telling the user to finish the code. Only Ready-to-use`;

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

function checkToken(req, res) {
    const token = req.headers["x-ai-token"];
    if (token !== ACCESS_TOKEN) {
        res.status(403).json({ error: "Unauthorized" });
        return false;
    }
    return true;
}

function validateAction(parsed) {
    if (!parsed || typeof parsed.action !== "string") return false;
    if (!ALLOWED_ACTIONS.includes(parsed.action) && parsed.action !== "none") return false;
    if (typeof parsed.params !== "object" || Array.isArray(parsed.params)) return false;

    const p = parsed.params;

    switch (parsed.action) {
        case "spawnObject":
            if (!["Block", "Sphere", "Cylinder"].includes(p.shape)) return false;
            if (typeof p.x !== "number" || typeof p.y !== "number" || typeof p.z !== "number") return false;
            break;
        case "changeWeather":
            if (!["sunny", "rainy", "stormy"].includes(p.type)) return false;
            break;
        case "setGlobalMessage":
            if (typeof p.text !== "string" || p.text.length > 80) return false;
            break;
        case "moveObject":
            if (typeof p.name !== "string") return false;
            if (typeof p.x !== "number" || typeof p.y !== "number" || typeof p.z !== "number") return false;
            break;
        case "changeColor":
            if (typeof p.name !== "string") return false;
            if ([p.r, p.g, p.b].some(v => typeof v !== "number")) return false;
            break;
        case "executeCode":
            if (typeof p.code !== "string") return false;
            break;
    }
    return true;
}

app.post('/ai-command', async (req, res) => {
    if (!checkToken(req, res)) return;
    if (!rateLimit(req, res)) return;

    // Принимаем prompt и context из Roblox
    const { prompt, context } = req.body; 
    if (!prompt || typeof prompt !== "string" || prompt.length > 500) {
        return res.status(400).json({ error: "Invalid prompt" });
    }

    // Форматируем данные об игре для ИИ
    const gameContextString = context 
        ? `CURRENT GAME STATE:\n${JSON.stringify(context, null, 2)}`
        : "CURRENT GAME STATE: No data available.";

    console.log(`[AI-BRIDGE] prompt received: "${prompt}"`);

    try {
        const response = await fetch(GROQ_URL, {
            method: "POST",
            headers: {
                "Content-Type":  "application/json",
                "Authorization": `Bearer ${GROQ_API_KEY}`
            },
            body: JSON.stringify({
                model:       "llama-3.1-8b-instant",
                max_tokens:  2000,
                temperature: 0.4,
                response_format: { type: "json_object" },
                messages: [
                    { role: "system", content: SYSTEM_PROMPT },
                    { role: "system", content: gameContextString }, // ИИ видит точные цифры и переменные игры
                    { role: "user",   content: prompt }
                ]
            })
        });

        const data = await response.json();

        if (!data.choices || !data.choices[0]) {
            return res.status(502).json({ error: "No response from Groq" });
        }

        const rawText = data.choices[0].message.content.trim();
        let parsed = JSON.parse(rawText);

        if (!validateAction(parsed)) {
            return res.status(422).json({ error: "Action failed validation", raw: parsed });
        }

        return res.json(parsed);

    } catch (err) {
        return res.status(500).json({ error: "Internal server error" });
    }
});

app.get('/', (_req, res) => res.send("AI Bridge (Groq) is running."));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AI Bridge listening on port ${PORT}`));
