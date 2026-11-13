import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const API_BASE = "https://api.football-data.org/v4";

app.use(express.json());

// CORS
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, X-Auth-Token, Authorization"
  );
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

// Vérification de la clé API
function getToken() {
  const token = (
    process.env.FOOTBALL_DATA_API_KEY ||
    process.env.FOOTBALL_DATA_API_TOKEN ||
    process.env.FOOTBALL_DATA_TOKEN ||
    ""
  ).trim().replace(/^['"]|['"]$/g, "");

  if (!token || ["undefined", "null"].includes(token.toLowerCase())) {
    return null;
  }

  return token;
}

// Date du Burkina Faso
function getBurkinaDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Ouagadougou",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

// Ajouter des jours
function addDays(date, days) {
  const result = new Date(date + "T00:00:00Z");
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}

// Connexion officielle football-data.org
async function footballRequest(endpoint, req, res, options = {}) {
  const token = getToken();

  if (!token) {
    return res.status(503).json({
      status: "ERROR",
      message: "Clé FOOTBALL_DATA_API_KEY manquante sur Render."
    });
  }

  try {
    const url = new URL(API_BASE + endpoint);

    // Paramètres reçus
    for (const [key, value] of Object.entries(req.query || {})) {
      if (
        typeof value === "string" &&
        !["dateFrom", "dateTo", "date"].includes(key)
      ) {
        url.searchParams.set(key, value);
      }
    }

    if (options.today) {
      const today = getBurkinaDate();
      url.searchParams.set("dateFrom", today);
      url.searchParams.set("dateTo", today);
    }

    if (options.upcoming) {
      const today = getBurkinaDate();

      // 10 dates calendaires maximum, limite de l'API respectée
      const dateTo = addDays(today, 9);

      url.searchParams.set("dateFrom", today);
      url.searchParams.set("dateTo", dateTo);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);

    let response;

    try {
      response = await fetch(url.toString(), {
        method: "GET",
        headers: {
          "X-Auth-Token": token,
          "Accept": "application/json"
        },
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }

    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
      return res.status(response.status).json({
        status: "ERROR",
        application: "DRABO73 VIP PRONOS",
        api_connection: "ERROR",
        httpStatus: response.status,
        message: body.message || "Erreur football-data.org",
        details: body
      });
    }

    return res.json({
      ...body,
      status: "OK",
      application: "DRABO73 VIP PRONOS",
      api_connection: "CONNECTED",
      serverDate: getBurkinaDate(),
      totalMatches: Array.isArray(body.matches)
        ? body.matches.length
        : 0
    });

  } catch (error) {
    return res.status(502).json({
      status: "ERROR",
      application: "DRABO73 VIP PRONOS",
      api_connection: "ERROR",
      message: error.name === "AbortError"
        ? "Délai de connexion dépassé."
        : "Impossible de joindre football-data.org.",
      details: error.message
    });
  }
}

// État du serveur
app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    application: "DRABO73 VIP PRONOS",
    serverDate: getBurkinaDate()
  });
});

// État de la configuration API
app.get("/api/status", (req, res) => {
  res.json({
    status: "OK",
    application: "DRABO73 VIP PRONOS",
    api_connection: getToken() ? "CONNECTED" : "NOT_CONFIGURED",
    tokenConfigured: Boolean(getToken()),
    serverDate: getBurkinaDate()
  });
});

// Matchs du jour
app.get("/api/matches", (req, res) => {
  return footballRequest("/matches", req, res, {
    today: true
  });
});

// Matchs à venir : période maximale de 10 jours
app.get("/api/matches/upcoming", (req, res) => {
  return footballRequest("/matches", req, res, {
    upcoming: true
  });
});

// Détails d'un match
app.get("/api/matches/:id", (req, res) => {
  const id = String(req.params.id).replace(/^fd-/i, "");

  if (!/^\d+$/.test(id)) {
    return res.status(400).json({
      status: "ERROR",
      message: "Identifiant de match invalide."
    });
  }

  return footballRequest(`/matches/${id}`, req, res);
});

// Confrontations directes
app.get("/api/matches/:id/head2head", (req, res) => {
  const id = String(req.params.id).replace(/^fd-/i, "");

  if (!/^\d+$/.test(id)) {
    return res.status(400).json({
      status: "ERROR",
      message: "Identifiant invalide."
    });
  }

  return footballRequest(`/matches/${id}/head2head`, req, res);
});

// Compétitions
app.get("/api/competitions", (req, res) => {
  return footballRequest("/competitions", req, res);
});

// Matchs d'une compétition
app.get("/api/competitions/:id/matches", (req, res) => {
  const id = req.params.id;

  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    return res.status(400).json({
      status: "ERROR",
      message: "Code de compétition invalide."
    });
  }

  return footballRequest(`/competitions/${id}/matches`, req, res);
});

// Classement
app.get("/api/competitions/:id/standings", (req, res) => {
  const id = req.params.id;

  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    return res.status(400).json({
      status: "ERROR",
      message: "Code de compétition invalide."
    });
  }

  return footballRequest(`/competitions/${id}/standings`, req, res);
});

// Fichiers publics du site
const publicDir = path.join(__dirname, "public");
const distDir = path.join(__dirname, "dist");

if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
}

if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
}

// Page principale
app.get("/", (req, res) => {
  const candidates = [
    path.join(publicDir, "index.html"),
    path.join(distDir, "index.html"),
    path.join(__dirname, "index.html")
  ];

  const indexFile = candidates.find(file => fs.existsSync(file));

  if (!indexFile) {
    return res.status(404).send("index.html introuvable.");
  }

  res.sendFile(indexFile);
});

// Routes inconnues
app.use("/api", (req, res) => {
  res.status(404).json({
    status: "ERROR",
    message: "Route API introuvable."
  });
});

app.use((req, res) => {
  res.status(404).send("Page introuvable.");
});

// Démarrage
app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `[DRABO73 VIP PRONOS] Serveur actif sur le port ${PORT}`
  );
});