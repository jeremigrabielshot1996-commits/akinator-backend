// server.js - Backend Express para el Akinator de Roblox.
// La API Key de Anthropic vive solo aquí (variables de entorno).

const express = require("express");
const crypto = require("crypto");

// Configuración
const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SHARED_SECRET = process.env.ROBLOX_SHARED_SECRET;
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
const MAX_QUESTIONS = 20; // tras este número se fuerza una respuesta final
const SESSION_TTL_MS = 30 * 60 * 1000; // sesiones inactivas se descartan a los 30 min
const MAX_SESSIONS = 500; // tope de sesiones en memoria

if (!ANTHROPIC_API_KEY || !SHARED_SECRET) {
  console.error("Faltan ANTHROPIC_API_KEY o ROBLOX_SHARED_SECRET");
  process.exit(1);
}

// Prompt del sistema: define el juego y el formato JSON de salida
const SYSTEM_PROMPT = `Eres Akinator, un juego de adivinanza de personajes (reales o ficticios: anime, películas, series, videojuegos, historia, deportes, música).
El jugador piensa en un personaje y tú haces preguntas de sí/no para adivinarlo.
Reglas:
- Haz UNA sola pregunta corta por turno, en español. Las respuestas posibles son: "Sí", "No" o "No lo sé".
- Empieza con preguntas amplias y ve acotando. No repitas preguntas.
- Cuando tengas suficiente confianza, adivina.
- Responde SIEMPRE y SOLO con un objeto JSON válido, sin texto adicional ni markdown.
Formatos permitidos:
{"type": "question", "text": "¿Es un personaje de anime?"}
{"type": "result", "name": "Goku", "description": "El saiyajin de Dragon Ball"}`;

const ANSWER_TEXT = { yes: "Sí", no: "No", unknown: "No lo sé" };

// Sesiones en memoria: sessionId -> { messages, count, updatedAt }
const sessions = new Map();

function cleanupSessions() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.updatedAt > SESSION_TTL_MS) sessions.delete(id);
  }
}
setInterval(cleanupSessions, 5 * 60 * 1000).unref();

// Extrae y valida el JSON de la respuesta del modelo
function parseModelJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  try {
    const obj = JSON.parse(text.slice(start, end + 1));
    if (obj.type === "question" && typeof obj.text === "string" && obj.text.trim()) {
      return { type: "question", text: obj.text.trim() };
    }
    if (obj.type === "result" && typeof obj.name === "string" && obj.name.trim()) {
      return {
        type: "result",
        name: obj.name.trim(),
        description: typeof obj.description === "string" ? obj.description.trim() : "",
      };
    }
  } catch (_) {}
  return null;
}

// Llama a la API de Anthropic (hasta 2 intentos si el JSON viene mal formado)
async function askModel(messages) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 300,
        system: SYSTEM_PROMPT,
        messages,
      }),
    });
    if (!res.ok) {
      throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();
    const text = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    const parsed = parseModelJson(text);
    if (parsed) return parsed;
  }
  throw new Error("El modelo no devolvió un JSON válido");
}

const app = express();
app.use(express.json({ limit: "2kb" }));

// Autenticación: solo el servidor de Roblox conoce el secreto compartido
function authenticate(req, res, next) {
  const provided = Buffer.from(String(req.get("x-roblox-secret") || ""));
  const expected = Buffer.from(SHARED_SECRET);
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    return res.status(401).json({ error: "No autorizado" });
  }
  next();
}

app.post("/api/akinator", authenticate, async (req, res) => {
  const { sessionId, action, answer } = req.body || {};
  if (typeof sessionId !== "string" || sessionId.length < 8 || sessionId.length > 64) {
    return res.status(400).json({ error: "sessionId inválido" });
  }

  let session;
  if (action === "start") {
    if (sessions.size >= MAX_SESSIONS) cleanupSessions();
    if (sessions.size >= MAX_SESSIONS) {
      return res.status(503).json({ error: "Servidor ocupado, intenta de nuevo." });
    }
    session = {
      messages: [{ role: "user", content: "Ya pensé en un personaje. Haz tu primera pregunta." }],
      count: 0,
      updatedAt: Date.now(),
    };
    sessions.set(sessionId, session);
  } else if (action === "answer") {
    session = sessions.get(sessionId);
    if (!session) return res.status(404).json({ error: "Sesión no encontrada, reinicia la partida." });
    if (!ANSWER_TEXT[answer]) return res.status(400).json({ error: "Respuesta inválida" });

    let content = ANSWER_TEXT[answer];
    if (session.count >= MAX_QUESTIONS) {
      content += '\n(Ya no puedes preguntar más: responde ahora con type "result".)';
    }
    session.messages.push({ role: "user", content });
  } else {
    return res.status(400).json({ error: "action inválida" });
  }

  try {
    const reply = await askModel(session.messages);
    session.updatedAt = Date.now();

    if (reply.type === "result") {
      sessions.delete(sessionId);
      return res.json(reply);
    }
    session.count += 1;
    session.messages.push({ role: "assistant", content: JSON.stringify(reply) });
    return res.json({ ...reply, count: session.count });
  } catch (err) {
    console.error("[akinator]", err.message);
    // Revierte el último mensaje del jugador para que pueda reintentar
    if (action === "start") sessions.delete(sessionId);
    else session.messages.pop();
    return res.status(502).json({ error: "La IA no respondió. Intenta de nuevo." });
  }
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Akinator backend en puerto ${PORT}`));
