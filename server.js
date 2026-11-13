import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FOOTBALL_DATA_BASE_URL = "https://football-data.org";

function sanitizeToken(raw) {
  if (!raw || typeof raw !== "string") return undefined;
  const cleaned = raw.trim().replace(/^['"]+|['"]+$/g, "").trim();
  if (!cleaned) return undefined;
  const lower = cleaned.toLowerCase();
  if (["undefined", "null", "your_football_data_api_key", "my_football_data_api_key"].includes(lower)) {
    return undefined;
  }
  return cleaned;
}

function getApiToken(req) {
  const envToken =
    sanitizeToken(process.env.FOOTBALL_DATA_API_KEY) ||
    sanitizeToken(process.env.FOOTBALL_DATA_API_TOKEN) ||
    sanitizeToken(process.env.FOOTBALL_DATA_TOKEN) ||
    sanitizeToken(process.env.X_AUTH_TOKEN);
  if (envToken) return envToken;

  const customHeader = req?.headers["x-auth-token"];
  if (typeof customHeader === "string") return sanitizeToken(customHeader);
  return undefined;
}

function getTodayAndTomorrowDates() {
  const now = new Date();
  const today = now.toISOString().split("T")[0];
  const tomorrowDate = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const tomorrow = tomorrowDate.toISOString().split("T")[0];
  return { today, tomorrow };
}

async function proxyToFootballData(targetPath, req, res, forceTodayMatches = false) {
  const token = getApiToken(req);
  if (!token) {
    return res.status(503).json({
      status: "ERROR",
      error: "FOOTBALL_DATA_API_KEY_MISSING",
      message: "La clé FOOTBALL_DATA_API_KEY est manquante sur Render (Environment)."
    });
  }

  const queryParams = new URLSearchParams();
  for (const [key, value] of Object.entries(req.query)) {
    if (typeof value === "string") queryParams.append(key, value);
  }

  // Force les matchs du jour exact si aucune date n'est fournie par l'APK
  if (forceTodayMatches && !queryParams.has("date") && !queryParams.has("dateFrom")) {
    const { today } = getTodayAndTomorrowDates();
    queryParams.append("dateFrom", today);
    queryParams.append("dateTo", today);
  }

  const queryString = queryParams.toString();
  const url = `${FOOTBALL_DATA_BASE_URL}${targetPath}${queryString ? `?${queryString}` : ""}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    const upstreamResponse = await fetch(url, {
      method: req.method,
      headers: {
        "X-Auth-Token": token,
        Accept: "application/json"
      },
      signal: controller.signal
    });

    const responseStatus = upstreamResponse.status;
    const data = await upstreamResponse.json();

    if (upstreamResponse.ok && data && typeof data === "object") {
      return res.status(responseStatus).json({
        status: "OK",
        application: "DRABO73 VIP PRONOS",
        api_connection: "CONNECTED",
        serverDate: getTodayAndTomorrowDates().today,
        totalMatches: Array.isArray(data.matches) ? data.matches.length : 0,
        ...data
      });
    }

    return res.status(responseStatus).json({
      status: "ERROR",
      httpStatus: responseStatus,
      ...data
    });
  } catch (error) {
    return res.status(502).json({
      status: "ERROR",
      message: "Erreur de connexion entre Render et football-data.org.",
      details: error.message
    });
  } finally {
    clearTimeout(timer);
  }
}

const app = express();
const PORT = parseInt(process.env.PORT || "3000", 10);

app.use(express.json());
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Auth-Token, Authorization");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "OK",
    application: "DRABO73 VIP PRONOS",
    date: getTodayAndTomorrowDates().today
  });
});

app.get("/api/status", (_req, res) => {
  const token = getApiToken();
  res.status(200).json({
    status: "OK",
    api_connection: token ? "CONNECTED" : "NOT_CONFIGURED",
    tokenConfigured: Boolean(token),
    serverDate: getTodayAndTomorrowDates().today
  });
});

// Route principale des matchs du jour utilisée par votre APK
app.get("/api/matches", (req, res) => proxyToFootballData("/matches", req, res, true));

app.get("/api/matches/:id/head2head", (req, res) => {
  const cleanId = String(req.params.id || "").replace(/^fd-/i, "").trim();
  proxyToFootballData(`/matches/${cleanId}/head2head`, req, res);
});

app.get("/api/matches/:id", (req, res) => {
  const cleanId = String(req.params.id || "").replace(/^fd-/i, "").trim();
  proxyToFootballData(`/matches/${cleanId}`, req, res);
});

app.get("/api/competitions", (req, res) => proxyToFootballData("/competitions", req, res));
app.get("/api/competitions/:id/matches", (req, res) =>
  proxyToFootballData(`/competitions/${req.params.id}/matches`, req, res)
);
app.get("/api/competitions/:id/standings", (req, res) =>
  proxyToFootballData(`/competitions/${req.params.id}/standings`, req, res)
);

app.all("/api/football/*", (req, res) => {
  const subPath = req.path
    .replace(/^\/api\/football/, "")
    .replace(/\/matches\/fd-(\d+)/i, "/matches/$1");
  proxyToFootballData(subPath, req, res, subPath === "/matches");
});

app.use(express.static(path.join(__dirname, "public")));
if (fs.existsSync(path.join(__dirname, "dist"))) {
  app.use(express.static(path.join(__dirname, "dist")));
}
app.use(express.static(__dirname));

app.get("*", (_req, res) => {
  const distIndex = path.join(__dirname, "dist", "index.html");
  const rootIndex = path.join(__dirname, "index.html");
  if (fs.existsSync(distIndex)) return res.sendFile(distIndex);
  if (fs.existsSync(rootIndex)) return res.sendFile(rootIndex);
  res.status(404).send("index.html introuvable.");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[DRABO73 VIP PRONOS] Serveur connecté sur le port ${PORT}`);
});
