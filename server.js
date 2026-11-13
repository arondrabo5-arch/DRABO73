
import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FOOTBALL_DATA_BASE_URL =
  "https://api.football-data.org/v4";

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// Nettoyage et validation de la clé API
function sanitizeToken(raw) {
  if (!raw || typeof raw !== "string") return undefined;

  const cleaned = raw
    .trim()
    .replace(/^['"]+|['"]+$/g, "")
    .trim();

  if (!cleaned) return undefined;

  if ([
    "undefined",
    "null",
    "your_football_data_api_key",
    "my_football_data_api_key"
  ].includes(cleaned.toLowerCase())) {
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

  const header = req?.headers?.["x-auth-token"];

  return typeof header === "string"
    ? sanitizeToken(header)
    : undefined;
}

// Date locale du Burkina Faso
function getBurkinaDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Ouagadougou",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

// Ajouter des jours à une date sans dépendre du fuseau horaire du serveur
function addDaysToDate(dateString, days) {
  const date = new Date(`${dateString}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// Proxy sécurisé vers football-data.org
async function proxyToFootballData(
  targetPath,
  req,
  res,
  forceTodayMatches = false,
  defaultDateRange = null
) {
  const token = getApiToken(req);

  if (!token) {
    return res.status(503).json({
      status: "ERROR",
      application: "DRABO73 VIP PRONOS",
      error: "FOOTBALL_DATA_API_KEY_MISSING",
      message: "Clé API manquante sur Render."
    });
  }

  try {
    const url = new URL(
      `${FOOTBALL_DATA_BASE_URL}${targetPath}`
    );

    // Transmettre les paramètres de recherche
    for (const [key, value] of Object.entries(req.query || {})) {
      if (
        typeof value === "string" ||
        typeof value === "number"
      ) {
        url.searchParams.set(key, String(value));
      }
    }

    // Matchs du jour au Burkina Faso
    if (
      forceTodayMatches &&
      !url.searchParams.has("date") &&
      !url.searchParams.has("dateFrom") &&
      !url.searchParams.has("dateTo")
    ) {
      const today = getBurkinaDate();

      url.searchParams.set("dateFrom", today);
      url.searchParams.set("dateTo", today);
    }

    // Période par défaut des matchs à venir
    if (
      defaultDateRange &&
      !url.searchParams.has("date") &&
      !url.searchParams.has("dateFrom") &&
      !url.searchParams.has("dateTo")
    ) {
      url.searchParams.set(
        "dateFrom",
        defaultDateRange.dateFrom
      );

      url.searchParams.set(
        "dateTo",
        defaultDateRange.dateTo
      );
    }

    const controller = new AbortController();

    const timer = setTimeout(
      () => controller.abort(),
      15000
    );

    let upstreamResponse;

    try {
      upstreamResponse = await fetch(url.toString(), {
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

    const responseText = await upstreamResponse.text();

    let data;

    try {
      data = responseText
        ? JSON.parse(responseText)
        : {};
    } catch {
      data = { rawResponse: responseText };
    }

    if (!upstreamResponse.ok) {
      return res.status(upstreamResponse.status).json({
        status: "ERROR",
        application: "DRABO73 VIP PRONOS",
        api_connection: "ERROR",
        httpStatus: upstreamResponse.status,
        message:
          data.message ||
          "Erreur retournée par football-data.org.",
        details: data
      });
    }

    return res.status(200).json({
      ...data,
      status: "OK",
      application: "DRABO73 VIP PRONOS",
      api_connection: "CONNECTED",
      serverDate: getBurkinaDate(),
      totalMatches: Array.isArray(data.matches)
        ? data.matches.length
        : 0,
      totalCompetitions: Array.isArray(data.competitions)
        ? data.competitions.length
        : 0
    });

  } catch (error) {
    const timeout = error.name === "AbortError";

    return res.status(502).json({
      status: "ERROR",
      application: "DRABO73 VIP PRONOS",
      api_connection: "ERROR",
      message: timeout
        ? "Délai de connexion dépassé."
        : "Erreur de connexion à football-data.org.",
      details: error.message
    });
  }
}

// Configuration Express
app.use(express.json());

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, OPTIONS"
  );
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

// Vérification du serveur
app.get("/health", (_req, res) => {
  res.json({
    status: "OK",
    application: "DRABO73 VIP PRONOS",
    date: getBurkinaDate()
  });
});

// Vérification de la configuration API
app.get("/api/status", (req, res) => {
  const token = getApiToken(req);

  res.json({
    status: "OK",
    application: "DRABO73 VIP PRONOS",
    api_connection: token
      ? "CONNECTED"
      : "NOT_CONFIGURED",
    tokenConfigured: Boolean(token),
    serverDate: getBurkinaDate()
  });
});

// Matchs du jour
app.get("/api/matches", (req, res) =>
  proxyToFootballData("/matches", req, res, true)
);

// Matchs d'aujourd'hui et des 14 jours suivants
// IMPORTANT : cette route doit rester avant /api/matches/:id
app.get("/api/matches/upcoming", (req, res) => {
  const today = getBurkinaDate();

  const dateTo = addDaysToDate(today, 14);

  return proxyToFootballData(
    "/matches",
    req,
    res,
    false,
    {
      dateFrom: today,
      dateTo
    }
  );
});

// Détails d'un match
app.get("/api/matches/:id", (req, res) => {
  const id = String(req.params.id || "")
    .replace(/^fd-/i, "");

  if (!/^\d+$/.test(id)) {
    return res.status(400).json({
      status: "ERROR",
      message: "Identifiant de match invalide."
    });
  }

  return proxyToFootballData(
    `/matches/${id}`,
    req,
    res
  );
});

// Confrontations directes
app.get("/api/matches/:id/head2head", (req, res) => {
  const id = String(req.params.id || "")
    .replace(/^fd-/i, "");

  if (!/^\d+$/.test(id)) {
    return res.status(400).json({
      status: "ERROR",
      message: "Identifiant de match invalide."
    });
  }

  return proxyToFootballData(
    `/matches/${id}/head2head`,
    req,
    res
  );
});

// Liste des compétitions
app.get("/api/competitions", (req, res) =>
  proxyToFootballData("/competitions", req, res)
);

// Matchs d'une compétition
app.get("/api/competitions/:id/matches", (req, res) => {
  const id = String(req.params.id || "");

  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    return res.status(400).json({
      status: "ERROR",
      message: "Code de compétition invalide."
    });
  }

  return proxyToFootballData(
    `/competitions/${id}/matches`,
    req,
    res
  );
});

// Classement d'une compétition
app.get("/api/competitions/:id/standings", (req, res) => {
  const id = String(req.params.id || "");

  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    return res.status(400).json({
      status: "ERROR",
      message: "Code de compétition invalide."
    });
  }

  return proxyToFootballData(
    `/competitions/${id}/standings`,
    req,
    res
  );
});

// Compatibilité avec les anciennes routes de l'APK
app.use("/api/football", (req, res) => {
  const subPath = req.path.replace(
    /\/matches\/fd-(\d+)/i,
    "/matches/$1"
  );

  if (!subPath.startsWith("/")) {
    return res.status(400).json({
      status: "ERROR",
      message: "Route API invalide."
    });
  }

  return proxyToFootballData(
    subPath,
    req,
    res,
    subPath === "/matches"
  );
});

// Route API inconnue
app.use("/api", (_req, res) => {
  res.status(404).json({
    status: "ERROR",
    message: "Route API introuvable."
  });
});

// Fichiers du site
app.use(express.static(path.join(__dirname, "public")));

if (fs.existsSync(path.join(__dirname, "dist"))) {
  app.use(express.static(path.join(__dirname, "dist")));
}

app.use(express.static(__dirname));

// Page principale
app.get("*", (_req, res) => {
  const distIndex = path.join(
    __dirname,
    "dist",
    "index.html"
  );

  const rootIndex = path.join(
    __dirname,
    "index.html"
  );

  if (fs.existsSync(distIndex)) {
    return res.sendFile(distIndex);
  }

  if (fs.existsSync(rootIndex)) {
    return res.sendFile(rootIndex);
  }

  return res.status(404).send("index.html introuvable.");
});

// Démarrage du serveur
app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `[DRABO73 VIP PRONOS] Serveur actif sur le port ${PORT}`
  );
});
