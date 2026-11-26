
import express from "express";
import crypto from "crypto";
import dotenv from "dotenv";
import cors from "cors";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const API_BASE = "https://api.football-data.org/v4";
const TIMEZONE = "Africa/Ouagadougou";

const FOOTBALL_TOKEN = (
  process.env.FOOTBALL_DATA_API_KEY ||
  process.env.FOOTBALL_TOKEN ||
  ""
).trim();

const OWNER_ACCESS_CODE = (
  process.env.OWNER_ACCESS_CODE ||
  process.env.ADMIN_SECRET_KEY ||
  ""
).trim();

const OWNER_TOKEN_SECRET = (
  process.env.OWNER_TOKEN_SECRET ||
  process.env.ADMIN_TOKEN_SECRET ||
  ""
).trim();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

// =====================================
// OUTILS
// =====================================

function localDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function addDays(dateString, days) {
  const date = new Date(`${dateString}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function safeEqual(a, b) {
  const first = Buffer.from(String(a || ""));
  const second = Buffer.from(String(b || ""));

  return first.length === second.length &&
    crypto.timingSafeEqual(first, second);
}

function createOwnerToken() {
  const payload = Buffer.from(JSON.stringify({
    role: "owner",
    vip: true,
    analysis: true,
    exp: Date.now() + 30 * 24 * 60 * 60 * 1000
  })).toString("base64url");

  const signature = crypto
    .createHmac("sha256", OWNER_TOKEN_SECRET)
    .update(payload)
    .digest("hex");

  return `${payload}.${signature}`;
}

function verifyOwnerToken(token) {
  if (!token || !OWNER_TOKEN_SECRET) return false;

  const parts = token.split(".");
  if (parts.length !== 2) return false;

  const [payload, signature] = parts;

  const expected = crypto
    .createHmac("sha256", OWNER_TOKEN_SECRET)
    .update(payload)
    .digest("hex");

  if (!safeEqual(signature, expected)) return false;

  try {
    const data = JSON.parse(
      Buffer.from(payload, "base64url").toString()
    );

    return data.role === "owner" &&
      data.vip === true &&
      data.exp > Date.now();
  } catch {
    return false;
  }
}

function requireOwner(req, res, next) {
  const authorization = req.headers.authorization || "";
  const token = authorization.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";

  if (!verifyOwnerToken(token)) {
    return res.status(401).json({
      status: "ERROR",
      message: "Accès propriétaire refusé"
    });
  }

  next();
}

// =====================================
// CONNEXION FOOTBALL-DATA
// =====================================

async function footballRequest(endpoint) {
  if (!FOOTBALL_TOKEN) {
    throw new Error("Aucun jeton FOOTBALL_DATA_API_KEY configuré");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(`${API_BASE}${endpoint}`, {
      method: "GET",
      headers: {
        "X-Auth-Token": FOOTBALL_TOKEN,
        "Accept": "application/json"
      },
      signal: controller.signal
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const error = new Error(
        data.message || `Football API erreur ${response.status}`
      );
      error.status = response.status;
      throw error;
    }

    return data;
  } finally {
    clearTimeout(timeout);
  }
}

function handleError(res, error) {
  console.error("DRABO73:", error.message);

  return res.status(error.status || 500).json({
    status: "ERROR",
    message: error.name === "AbortError"
      ? "Délai de connexion dépassé"
      : error.message
  });
}

// =====================================
// ACCUEIL ET SANTÉ DU SERVEUR
// =====================================

app.get("/", (req, res) => {
  res.json({
    status: "OK",
    application: "DRABO73 VIP PRONOS",
    slogan: "LA CONFIANCE RESTE",
    version: "4.0.0",
    server: "Serveur actif"
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    server: "DRABO73",
    time: new Date().toISOString()
  });
});

app.get("/api/status", (req, res) => {
  res.json({
    status: "OK",
    application: "DRABO73 VIP PRONOS",
    version: "4.0.0",
    footballTokenConfigured: Boolean(FOOTBALL_TOKEN),
    ownerConfigured: Boolean(
      OWNER_ACCESS_CODE && OWNER_TOKEN_SECRET
    ),
    date: localDate(),
    timezone: TIMEZONE
  });
});

// =====================================
// CONNEXION PROPRIÉTAIRE
// =====================================

app.post("/api/owner/access", (req, res) => {
  if (!OWNER_ACCESS_CODE || !OWNER_TOKEN_SECRET) {
    return res.status(503).json({
      status: "ERROR",
      message: "Configuration propriétaire manquante"
    });
  }

  const code = String(req.body?.code || "");

  if (!safeEqual(code, OWNER_ACCESS_CODE)) {
    return res.status(401).json({
      status: "ERROR",
      message: "Code propriétaire incorrect"
    });
  }

  const token = createOwnerToken();

  res.json({
    status: "OK",
    role: "owner",
    vip: true,
    analysis: true,
    paymentRequired: false,
    token
  });
});

app.get("/api/owner/verify", requireOwner, (req, res) => {
  res.json({
    status: "OK",
    role: "owner",
    vip: true,
    analysis: true,
    paymentRequired: false
  });
});

// =====================================
// MATCHS DU JOUR
// =====================================

app.get("/api/matches", async (req, res) => {
  try {
    const date = localDate();

    const data = await footballRequest(
      `/matches?dateFrom=${date}&dateTo=${date}`
    );

    res.json({
      status: "OK",
      date,
      total: data.matches?.length || 0,
      matches: data.matches || []
    });
  } catch (error) {
    handleError(res, error);
  }
});

// =====================================
// PROCHAINS MATCHS
// =====================================

app.get("/api/matches/upcoming", async (req, res) => {
  try {
    const dateFrom = localDate();
    const dateTo = addDays(dateFrom, 7);

    const data = await footballRequest(
      `/matches?dateFrom=${dateFrom}&dateTo=${dateTo}&status=SCHEDULED`
    );

    res.json({
      status: "OK",
      dateFrom,
      dateTo,
      total: data.matches?.length || 0,
      matches: data.matches || []
    });
  } catch (error) {
    handleError(res, error);
  }
});

// =====================================
// HISTORIQUE DES RÉSULTATS
// =====================================

app.get("/api/matches/history", async (req, res) => {
  try {
    const dateTo = localDate();
    const dateFrom = addDays(dateTo, -7);

    const data = await footballRequest(
      `/matches?dateFrom=${dateFrom}&dateTo=${dateTo}&status=FINISHED`
    );

    res.json({
      status: "OK",
      dateFrom,
      dateTo,
      total: data.matches?.length || 0,
      matches: data.matches || []
    });
  } catch (error) {
    handleError(res, error);
  }
});

// =====================================
// MATCHS SUR UNE PÉRIODE
// =====================================

app.get("/api/matches/period", async (req, res) => {
  try {
    const from = req.query.from || localDate();
    const to = req.query.to || addDays(from, 7);

    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(from) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(to) ||
      from > to
    ) {
      return res.status(400).json({
        status: "ERROR",
        message: "Dates invalides"
      });
    }

    const data = await footballRequest(
      `/matches?dateFrom=${from}&dateTo=${to}`
    );

    res.json({
      status: "OK",
      dateFrom: from,
      dateTo: to,
      total: data.matches?.length || 0,
      matches: data.matches || []
    });
  } catch (error) {
    handleError(res, error);
  }
});

// =====================================
// DÉTAILS D'UN MATCH
// =====================================

app.get("/api/matches/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        status: "ERROR",
        message: "Identifiant de match invalide"
      });
    }

    const data = await footballRequest(`/matches/${id}`);

    res.json({
      status: "OK",
      match: data
    });
  } catch (error) {
    handleError(res, error);
  }
});

// =====================================
// ÉQUIPES
// =====================================

app.get("/api/teams/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        status: "ERROR",
        message: "Identifiant équipe invalide"
      });
    }

    const data = await footballRequest(`/teams/${id}`);

    res.json({
      status: "OK",
      team: data
    });
  } catch (error) {
    handleError(res, error);
  }
});

// =====================================
// MATCHS RÉCENTS D'UNE ÉQUIPE
// =====================================

app.get("/api/teams/:id/matches", async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        status: "ERROR",
        message: "Identifiant équipe invalide"
      });
    }

    const data = await footballRequest(
      `/teams/${id}/matches?limit=10`
    );

    res.json({
      status: "OK",
      total: data.matches?.length || 0,
      matches: data.matches || []
    });
  } catch (error) {
    handleError(res, error);
  }
});

// =====================================
// COMPÉTITIONS
// =====================================

app.get("/api/competitions", async (req, res) => {
  try {
    const data = await footballRequest("/competitions");

    res.json({
      status: "OK",
      total: data.competitions?.length || 0,
      competitions: data.competitions || []
    });
  } catch (error) {
    handleError(res, error);
  }
});

// =====================================
// CLASSEMENT
// =====================================

app.get("/api/competitions/:id/standings", async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        status: "ERROR",
        message: "Compétition invalide"
      });
    }

    const data = await footballRequest(
      `/competitions/${id}/standings`
    );

    res.json({
      status: "OK",
      standings: data.standings || [],
      competition: data.competition || null
    });
  } catch (error) {
    handleError(res, error);
  }
});

// =====================================
// MATCHS D'UNE COMPÉTITION
// =====================================

app.get("/api/competitions/:id/matches", async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        status: "ERROR",
        message: "Compétition invalide"
      });
    }

    const data = await footballRequest(
      `/competitions/${id}/matches`
    );

    res.json({
      status: "OK",
      total: data.matches?.length || 0,
      matches: data.matches || []
    });
  } catch (error) {
    handleError(res, error);
  }
});

// =====================================
// ANALYSE D'UN MATCH
// =====================================

app.get("/api/analysis/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        status: "ERROR",
        message: "Match invalide"
      });
    }

    const match = await footballRequest(`/matches/${id}`);

    res.json({
      status: "OK",
      match,
      analysis: {
        available: false,
        message:
          "Les statistiques détaillées et compositions ne sont pas fournies automatiquement par cette source pour tous les matchs. Aucune statistique ni prédiction n'est inventée."
      }
    });
  } catch (error) {
    handleError(res, error);
  }
});

// =====================================
// ROUTE INCONNUE
// =====================================

app.use((req, res) => {
  res.status(404).json({
    status: "ERROR",
    message: "Route introuvable",
    path: req.originalUrl
  });
});

// =====================================
// ERREURS GLOBALES
// =====================================

app.use((error, req, res, next) => {
  console.error("Erreur serveur:", error);

  res.status(500).json({
    status: "ERROR",
    message: "Erreur interne du serveur"
  });
});

// =====================================
// DÉMARRAGE
// =====================================

app.listen(PORT, "0.0.0.0", () => {
  console.log("--------------------------------");
  console.log("DRABO73 VIP PRONOS");
  console.log("LA CONFIANCE RESTE");
  console.log(`Serveur actif sur le port ${PORT}`);
  console.log(`Football API: ${Boolean(FOOTBALL_TOKEN)}`);
  console.log(`Owner: ${Boolean(OWNER_ACCESS_CODE)}`);
  console.log("--------------------------------");
});
