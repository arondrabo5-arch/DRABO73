
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

// ===============================
// CONFIGURATION CORS
// ===============================

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Auth-Token"
  );
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

// ===============================
// CLÉ FOOTBALL DATA
// ===============================

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

// ===============================
// DATE DU BURKINA FASO
// ===============================

function getBurkinaDate() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Ouagadougou",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  const values = {};

  for (const part of parts) {
    values[part.type] = part.value;
  }

  return `${values.year}-${values.month}-${values.day}`;
}

// ===============================
// AJOUTER DES JOURS
// ===============================

function addDays(date, days) {
  const result = new Date(date + "T00:00:00Z");
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}

// ===============================
// VÉRIFIER LES DATES
// ===============================

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) {
    return false;
  }

  const date = new Date(value + "T00:00:00Z");

  return !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value;
}

function daysBetween(first, last) {
  return Math.round(
    (Date.parse(last + "T00:00:00Z") -
     Date.parse(first + "T00:00:00Z")) / 86400000
  );
}

// ===============================
// REQUÊTE FOOTBALL DATA
// ===============================

async function footballRequest(endpoint, req, res, options = {}) {
  const token = getToken();

  if (!token) {
    return res.status(503).json({
      status: "ERROR",
      application: "DRABO73 VIP PRONOS",
      message: "Clé FOOTBALL_DATA_API_KEY manquante sur Render."
    });
  }

  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, 20000);

  try {
    const url = new URL(API_BASE + endpoint);

    // Paramètres de recherche
    for (const [key, value] of Object.entries(req.query || {})) {
      if (
        typeof value === "string" &&
        !["dateFrom", "dateTo", "date"].includes(key)
      ) {
        url.searchParams.set(key, value);
      }
    }

    // MATCHS DU JOUR
    if (options.today) {
      const today = getBurkinaDate();

      url.searchParams.set("dateFrom", today);
      url.searchParams.set("dateTo", today);
    }

    // MATCHS À VENIR
    // Maximum 10 jours inclusifs
    if (options.upcoming) {
      const today = getBurkinaDate();
      const lastDay = addDays(today, 9);

      url.searchParams.set("dateFrom", today);
      url.searchParams.set("dateTo", lastDay);
    }

    // PÉRIODE PERSONNALISÉE
    // MAXIMUM 10 JOURS
    if (options.customPeriod) {
      const from = req.query.dateFrom || getBurkinaDate();
      const to = req.query.dateTo || from;

      if (!validDate(from) || !validDate(to)) {
        return res.status(400).json({
          status: "ERROR",
          message: "Format de date invalide. Utilise YYYY-MM-DD."
        });
      }

      if (to < from || daysBetween(from, to) > 9) {
        return res.status(400).json({
          status: "ERROR",
          message: "La période ne doit pas dépasser 10 jours."
        });
      }

      url.searchParams.set("dateFrom", from);
      url.searchParams.set("dateTo", to);
    }

    console.log("[FOOTBALL DATA]", url.pathname, url.search);

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "X-Auth-Token": token,
        "Accept": "application/json"
      },
      signal: controller.signal
    });

    const responseText = await response.text();

    let body;

    try {
      body = JSON.parse(responseText);
    } catch {
      body = {
        message: responseText || "Réponse invalide de football-data.org."
      };
    }

    if (!response.ok) {
      console.error(
        "Football API error:",
        response.status,
        body
      );

      return res.status(response.status).json({
        status: "ERROR",
        application: "DRABO73 VIP PRONOS",
        api_connection: "ERROR",
        httpStatus: response.status,
        message: body.message || "Erreur football-data.org.",
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
    console.error("Football connection error:", error);

    return res.status(502).json({
      status: "ERROR",
      application: "DRABO73 VIP PRONOS",
      api_connection: "ERROR",
      message: error.name === "AbortError"
        ? "Délai de connexion dépassé."
        : "Impossible de joindre football-data.org.",
      details: error.message
    });

  } finally {
    clearTimeout(timer);
  }
}

// ===============================
// ÉTAT DU SERVEUR
// ===============================

app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    application: "DRABO73 VIP PRONOS",
    serverDate: getBurkinaDate()
  });
});

// ===============================
// ÉTAT DE L'API
// ===============================

app.get("/api/status", (req, res) => {
  const configured = Boolean(getToken());

  res.json({
    status: "OK",
    application: "DRABO73 VIP PRONOS",
    api_connection: configured
      ? "TOKEN_CONFIGURED"
      : "NOT_CONFIGURED",
    tokenConfigured: configured,
    serverDate: getBurkinaDate()
  });
});

// ===============================
// MATCHS DU JOUR
// ===============================

app.get("/api/matches", (req, res) => {
  return footballRequest("/matches", req, res, {
    today: true
  });
});

// ===============================
// MATCHS À VENIR
// ===============================

app.get("/api/matches/upcoming", (req, res) => {
  return footballRequest("/matches", req, res, {
    upcoming: true
  });
});

// ===============================
// HISTORIQUE DES RÉSULTATS RÉELS
// MAXIMUM 10 JOURS
// ===============================

app.get("/api/matches/history", (req, res) => {
  const today = getBurkinaDate();

  const dateFrom = req.query.dateFrom || addDays(today, -9);
  const dateTo = req.query.dateTo || today;

  const historyRequest = {
    ...req,
    query: {
      ...req.query,
      dateFrom,
      dateTo,
      status: "FINISHED"
    }
  };

  return footballRequest("/matches", historyRequest, res, {
    customPeriod: true
  });
});

// ===============================
// PÉRIODE PERSONNALISÉE
// MAXIMUM 10 JOURS
// ===============================

app.get("/api/matches/period", (req, res) => {
  return footballRequest("/matches", req, res, {
    customPeriod: true
  });
});

// ===============================
// DÉTAILS D'UN MATCH
// ===============================

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

// ===============================
// CONFRONTATIONS DIRECTES
// ===============================

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

// ===============================
// COMPÉTITIONS
// ===============================

app.get("/api/competitions", (req, res) => {
  return footballRequest("/competitions", req, res);
});

// ===============================
// MATCHS D'UNE COMPÉTITION
// ===============================

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

// ===============================
// CLASSEMENT
// ===============================

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

// ===============================
// DOSSIERS DU SITE
// ===============================

const publicDir = path.join(__dirname, "public");
const distDir = path.join(__dirname, "dist");

if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
}

if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
}

// ===============================
// PAGE PRINCIPALE
// ===============================

app.get("/", (req, res) => {
  const candidates = [
    path.join(publicDir, "index.html"),
    path.join(distDir, "index.html"),
    path.join(__dirname, "index.html")
  ];

  const indexFile = candidates.find(file =>
    fs.existsSync(file)
  );

  if (!indexFile) {
    return res.status(404).send(
      "index.html introuvable. Vérifie le dossier public."
    );
  }

  res.sendFile(indexFile);
});

// ===============================
// API INCONNUE
// ===============================

app.use("/api", (req, res) => {
  res.status(404).json({
    status: "ERROR",
    message: "Route API introuvable."
  });
});

// ===============================
// PAGE INCONNUE
// ===============================

app.use((req, res) => {
  res.status(404).send("Page introuvable.");
});

// ===============================
// DÉMARRAGE
// ===============================

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `[DRABO73 VIP PRONOS] Serveur actif sur le port ${PORT}`
  );

  console.log(
    `[DRABO73] Clé API configurée : ${Boolean(getToken())}`
  );
});
