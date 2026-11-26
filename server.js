
import express from "express";
import crypto from "crypto";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const API_BASE = "https://api.football-data.org/v4";
const TIMEZONE = "Africa/Ouagadougou";

const OWNER_ACCESS_CODE = (
  process.env.OWNER_ACCESS_CODE ||
  process.env.ADMIN_SECRET_KEY ||
  ""
).trim();

const OWNER_TOKEN_SECRET = (
  process.env.OWNER_TOKEN_SECRET ||
  process.env.SESSION_SECRET ||
  process.env.ADMIN_SECRET_KEY ||
  ""
).trim();

const MAX_PERIOD_DAYS = 10;
const CACHE_TTL = 120000;
const cache = new Map();
const ownerAttempts = new Map();

app.set("trust proxy", 1);
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header(
    "Access-Control-Allow-Methods",
    "GET,POST,PUT,PATCH,DELETE,OPTIONS"
  );
  res.header(
    "Access-Control-Allow-Headers",
    "Content-Type,Authorization,x-admin-key"
  );

  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// --------------------------------------------------
// OUTILS
// --------------------------------------------------

function getBurkinaDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  const values = {};

  for (const part of parts) {
    if (part.type !== "literal") {
      values[part.type] = part.value;
    }
  }

  return `${values.year}-${values.month}-${values.day}`;
}

function addDays(date, amount) {
  const result = new Date(`${date}T12:00:00Z`);
  result.setUTCDate(result.getUTCDate() + amount);
  return result.toISOString().slice(0, 10);
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) {
    return false;
  }

  const date = new Date(`${value}T00:00:00Z`);

  return (
    !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
  );
}

function validatePeriod(from, to, maximum = MAX_PERIOD_DAYS) {
  if (!validDate(from) || !validDate(to)) {
    return "Dates invalides. Format YYYY-MM-DD attendu.";
  }

  if (from > to) {
    return "La date de début doit précéder la date de fin.";
  }

  const days = Math.round(
    (new Date(`${to}T00:00:00Z`) -
      new Date(`${from}T00:00:00Z`)) / 86400000
  );

  if (days > maximum) {
    return `La période ne doit pas dépasser ${maximum} jours.`;
  }

  return null;
}

function sortMatches(matches) {
  return [...matches].sort(
    (a, b) =>
      new Date(a.utcDate).getTime() -
      new Date(b.utcDate).getTime()
  );
}

function sendError(res, error) {
  console.error("API error:", error.message || error);

  return res.status(error.status || 500).json({
    status: "ERROR",
    message: error.message || "Erreur interne du serveur.",
    apiStatus: error.status || 500
  });
}

function getToken() {
  return (
    process.env.FOOTBALL_DATA_API_KEY ||
    process.env.FOOTBALL_DATA_API_TOKEN ||
    process.env.FOOTBALL_DATA_TOKEN ||
    ""
  ).trim();
}

// --------------------------------------------------
// CACHE
// --------------------------------------------------

function cacheGet(key) {
  const item = cache.get(key);

  if (!item || Date.now() > item.expiry) {
    cache.delete(key);
    return null;
  }

  return item.data;
}

function cacheSet(key, data) {
  cache.set(key, {
    data,
    expiry: Date.now() + CACHE_TTL
  });

  if (cache.size > 300) {
    const firstKey = cache.keys().next().value;
    cache.delete(firstKey);
  }
}

// --------------------------------------------------
// FOOTBALL-DATA.ORG V4
// --------------------------------------------------

async function footballRequest(endpoint, query = {}) {
  const token = getToken();

  if (!token) {
    throw Object.assign(
      new Error("Clé FOOTBALL_DATA_API_KEY non configurée sur Render."),
      { status: 503 }
    );
  }

  const url = new URL(`${API_BASE}${endpoint}`);

  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const cacheKey = url.toString();
  const cached = cacheGet(cacheKey);

  if (cached) return cached;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);

  try {
    const response = await fetch(cacheKey, {
      method: "GET",
      headers: {
        "X-Auth-Token": token,
        Accept: "application/json"
      },
      signal: controller.signal
    });

    const raw = await response.text();
    let data;

    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      throw Object.assign(
        new Error("Réponse illisible de football-data.org."),
        { status: 502 }
      );
    }

    if (!response.ok) {
      throw Object.assign(
        new Error(
          data.message ||
          data.error ||
          `Erreur football-data.org (${response.status}).`
        ),
        { status: response.status }
      );
    }

    cacheSet(cacheKey, data);
    return data;
  } catch (error) {
    if (error.name === "AbortError") {
      throw Object.assign(
        new Error("Délai de connexion dépassé."),
        { status: 504 }
      );
    }

    if (error.status) throw error;

    throw Object.assign(
      new Error("Impossible de contacter football-data.org."),
      { status: 502 }
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchMatchesInPeriod(from, to, extra = {}) {
  const error = validatePeriod(from, to, 365);

  if (error) {
    throw Object.assign(new Error(error), { status: 400 });
  }

  const matches = [];
  let cursor = from;

  while (cursor <= to) {
    const chunkEnd = addDays(cursor, 9);
    const end = chunkEnd > to ? to : chunkEnd;

    const data = await footballRequest("/matches", {
      ...extra,
      dateFrom: cursor,
      dateTo: end
    });

    if (Array.isArray(data.matches)) {
      matches.push(...data.matches);
    }

    cursor = addDays(end, 1);
  }

  return sortMatches(
    [...new Map(matches.map(m => [m.id, m])).values()]
  );
}

// --------------------------------------------------
// AUTHENTIFICATION PROPRIETAIRE
// --------------------------------------------------

function createOwnerToken() {
  if (!OWNER_TOKEN_SECRET) {
    throw new Error("OWNER_TOKEN_SECRET non configuré.");
  }

  const payload = Buffer.from(
    JSON.stringify({
      role: "owner",
      vip: true,
      lifetime: true,
      exp: Date.now() + 30 * 86400000
    })
  ).toString("base64url");

  const signature = crypto
    .createHmac("sha256", OWNER_TOKEN_SECRET)
    .update(payload)
    .digest("base64url");

  return `${payload}.${signature}`;
}

function verifyOwnerToken(token) {
  if (!token || !OWNER_TOKEN_SECRET) return false;

  const parts = String(token).split(".");
  if (parts.length !== 2) return false;

  const [payload, signature] = parts;

  const expected = crypto
    .createHmac("sha256", OWNER_TOKEN_SECRET)
    .update(payload)
    .digest("base64url");

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);

  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return false;
  }

  try {
    const data = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8")
    );

    return data.role === "owner" && Number(data.exp) > Date.now();
  } catch {
    return false;
  }
}

function getBearerToken(req) {
  const authorization = String(req.headers.authorization || "");

  return authorization.startsWith("Bearer ")
    ? authorization.slice(7).trim()
    : "";
}

function isOwnerRequest(req) {
  if (verifyOwnerToken(getBearerToken(req))) return true;

  const supplied = String(req.headers["x-admin-key"] || "").trim();

  if (!OWNER_ACCESS_CODE || !supplied) return false;

  const a = Buffer.from(supplied);
  const b = Buffer.from(OWNER_ACCESS_CODE);

  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireOwner(req, res, next) {
  if (!isOwnerRequest(req)) {
    return res.status(401).json({
      status: "ERROR",
      message: "Accès propriétaire non valide."
    });
  }

  next();
}

// --------------------------------------------------
// PLANS VIP
// --------------------------------------------------

const VIP_PLANS = [
  {
    id: "vip-7",
    name: "VIP 7 jours",
    duration: 7,
    price: 5000,
    currency: "FCFA"
  },
  {
    id: "vip-30",
    name: "VIP 30 jours",
    duration: 30,
    price: 15000,
    currency: "FCFA"
  },
  {
    id: "vip-90",
    name: "VIP 90 jours",
    duration: 90,
    price: 35000,
    currency: "FCFA"
  }
];

// --------------------------------------------------
// ANALYSE DES EQUIPES
// --------------------------------------------------

function calculateTeamForm(matches, teamId) {
  const finished = matches
    .filter(match =>
      match.status === "FINISHED" &&
      (match.homeTeam.id === teamId ||
       match.awayTeam.id === teamId)
    )
    .slice(-5);

  let played = 0;
  let wins = 0;
  let draws = 0;
  let losses = 0;
  let goalsFor = 0;
  let goalsAgainst = 0;

  for (const match of finished) {
    const home = match.homeTeam.id === teamId;

    const scored = home
      ? match.score.fullTime.home
      : match.score.fullTime.away;

    const conceded = home
      ? match.score.fullTime.away
      : match.score.fullTime.home;

    if (scored === null || conceded === null) continue;

    played++;
    goalsFor += scored;
    goalsAgainst += conceded;

    if (scored > conceded) wins++;
    else if (scored === conceded) draws++;
    else losses++;
  }

  return {
    played,
    wins,
    draws,
    losses,
    goalsFor,
    goalsAgainst,
    averageGoalsFor: played
      ? Number((goalsFor / played).toFixed(2))
      : null,
    averageGoalsAgainst: played
      ? Number((goalsAgainst / played).toFixed(2))
      : null
  };
}

function createPrediction(home, away) {
  if (!home.played || !away.played) {
    return {
      available: false,
      message: "Historique insuffisant pour établir une estimation fiable."
    };
  }

  const homeGoals = Math.max(
    0,
    (home.averageGoalsFor + away.averageGoalsAgainst) / 2 + 0.25
  );

  const awayGoals = Math.max(
    0,
    (away.averageGoalsFor + home.averageGoalsAgainst) / 2 - 0.15
  );

  const h = Math.min(5, Math.round(homeGoals));
  const a = Math.min(5, Math.round(awayGoals));

  const difference = homeGoals - awayGoals;

  let main;

  if (difference > 0.35) main = "1";
  else if (difference < -0.35) main = "2";
  else main = "X";

  return {
    available: true,
    main,
    doubleChance: difference >= 0 ? "1X" : "X2",
    exactScore: `${h}-${a}`,
    alternativeScores: [
      `${Math.max(0, h - 1)}-${a}`,
      `${h}-${Math.min(5, a + 1)}`
    ],
    estimatedGoals: {
      home: Number(homeGoals.toFixed(2)),
      away: Number(awayGoals.toFixed(2))
    },
    confidence: null,
    confidenceMessage:
      "Estimation statistique indicative. Aucune garantie de réussite."
  };
}

async function analyzeMatch(match) {
  if (!match.homeTeam?.id || !match.awayTeam?.id) {
    return {
      available: false,
      message: "Identifiants des équipes indisponibles."
    };
  }

  const [homeData, awayData] = await Promise.all([
    footballRequest(`/teams/${match.homeTeam.id}/matches`, {
      status: "FINISHED",
      limit: 5
    }),
    footballRequest(`/teams/${match.awayTeam.id}/matches`, {
      status: "FINISHED",
      limit: 5
    })
  ]);

  const homeForm = calculateTeamForm(
    homeData.matches || [],
    match.homeTeam.id
  );

  const awayForm = calculateTeamForm(
    awayData.matches || [],
    match.awayTeam.id
  );

  return {
    available: true,
    match: {
      id: match.id,
      homeTeam: match.homeTeam.name,
      awayTeam: match.awayTeam.name,
      utcDate: match.utcDate,
      competition: match.competition?.name || null
    },
    home: homeForm,
    away: awayForm,
    prediction: createPrediction(homeForm, awayForm),
    missingData: [
      "Compositions officielles non garanties",
      "Corners non fournis par cette analyse",
      "Possession et tirs non disponibles dans ces données"
    ]
  };
}

// --------------------------------------------------
// ROUTES PUBLIQUES
// --------------------------------------------------

app.get("/", (req, res) => {
  res.json({
    application: "DRABO73 VIP PRONOS",
    slogan: "LA CONFIANCE RESTE",
    version: "4.0.0",
    status: "Serveur actif",
    timezone: TIMEZONE
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
    footballTokenConfigured: Boolean(getToken()),
    ownerConfigured: Boolean(
      OWNER_ACCESS_CODE && OWNER_TOKEN_SECRET
    ),
    date: getBurkinaDate(),
    timezone: TIMEZONE
  });
});

app.get("/api/vip/plans", (req, res) => {
  res.json({
    status: "OK",
    plans: VIP_PLANS,
    paymentMethods: ["Orange Money", "Moov Money"],
    validation: "Validation manuelle par administrateur"
  });
});

app.get("/api/competitions", async (req, res) => {
  try {
    const data = await footballRequest("/competitions");

    res.json({
      status: "OK",
      source: "football-data.org",
      competitions: data.competitions || []
    });
  } catch (error) {
    sendError(res, error);
  }
});

// Matchs du jour
app.get("/api/matches/today", async (req, res) => {
  try {
    const date = getBurkinaDate();
    const matches = await fetchMatchesInPeriod(date, date);

    res.json({
      status: "OK",
      date,
      total: matches.length,
      matches
    });
  } catch (error) {
    sendError(res, error);
  }
});

// Matchs à venir
app.get("/api/matches/upcoming", async (req, res) => {
  try {
    const from = getBurkinaDate();
    const to = addDays(from, 7);

    const matches = await fetchMatchesInPeriod(from, to);

    const upcoming = matches.filter(m =>
      ["SCHEDULED", "TIMED"].includes(m.status)
    );

    res.json({
      status: "OK",
      dateFrom: from,
      dateTo: to,
      total: upcoming.length,
      matches: upcoming
    });
  } catch (error) {
    sendError(res, error);
  }
});

// Recherche par période
app.get("/api/matches", async (req, res) => {
  try {
    const from = req.query.dateFrom || getBurkinaDate();
    const to = req.query.dateTo || from;

    const error = validatePeriod(from, to);

    if (error) {
      return res.status(400).json({
        status: "ERROR",
        message: error
      });
    }

    const extra = {};

    if (req.query.competitions) {
      extra.competitions = req.query.competitions;
    }

    const matches = await fetchMatchesInPeriod(from, to, extra);

    res.json({
      status: "OK",
      dateFrom: from,
      dateTo: to,
      total: matches.length,
      matches
    });
  } catch (error) {
    sendError(res, error);
  }
});

// Détail d'un match
app.get("/api/matches/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        status: "ERROR",
        message: "Identifiant de match invalide."
      });
    }

    const data = await footballRequest(`/matches/${id}`);

    res.json({
      status: "OK",
      match: data.match || data
    });
  } catch (error) {
    sendError(res, error);
  }
});

// Analyse et pronostic
app.get("/api/matches/:id/analysis", async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        status: "ERROR",
        message: "Identifiant invalide."
      });
    }

    const data = await footballRequest(`/matches/${id}`);
    const analysis = await analyzeMatch(data.match || data);

    res.json({
      status: "OK",
      analysis
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/matches/:id/prediction", async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        status: "ERROR",
        message: "Identifiant invalide."
      });
    }

    const data = await footballRequest(`/matches/${id}`);
    const analysis = await analyzeMatch(data.match || data);

    res.json({
      status: "OK",
      prediction: analysis.prediction || null,
      analysis
    });
  } catch (error) {
    sendError(res, error);
  }
});

// Historique des résultats réels
app.get("/api/history", async (req, res) => {
  try {
    const to = req.query.dateTo || getBurkinaDate();
    const from = req.query.dateFrom || addDays(to, -30);

    const error = validatePeriod(from, to, 365);

    if (error) {
      return res.status(400).json({
        status: "ERROR",
        message: error
      });
    }

    const matches = await fetchMatchesInPeriod(from, to);

    const finished = matches.filter(
      m => m.status === "FINISHED"
    );

    res.json({
      status: "OK",
      dateFrom: from,
      dateTo: to,
      total: finished.length,
      matches: finished.map(m => ({
        id: m.id,
        date: m.utcDate,
        competition: m.competition?.name || null,
        homeTeam: m.homeTeam.name,
        awayTeam: m.awayTeam.name,
        homeScore: m.score.fullTime.home,
        awayScore: m.score.fullTime.away,
        status: m.status
      }))
    });
  } catch (error) {
    sendError(res, error);
  }
});

// --------------------------------------------------
// AUTHENTIFICATION ADMINISTRATEUR
// --------------------------------------------------

app.post("/api/admin/login", (req, res) => {
  const ip = req.ip || "unknown";

  const attempts = ownerAttempts.get(ip) || {
    count: 0,
    blockedUntil: 0
  };

  if (Date.now() < attempts.blockedUntil) {
    return res.status(429).json({
      status: "ERROR",
      message: "Trop de tentatives. Réessayez plus tard."
    });
  }

  const supplied = String(
    req.body.code || req.body.password || ""
  ).trim();

  if (!OWNER_ACCESS_CODE || !OWNER_TOKEN_SECRET) {
    return res.status(503).json({
      status: "ERROR",
      message: "Configuration administrateur incomplète sur Render."
    });
  }

  const a = Buffer.from(supplied);
  const b = Buffer.from(OWNER_ACCESS_CODE);

  const valid =
    a.length === b.length &&
    crypto.timingSafeEqual(a, b);

  if (!valid) {
    attempts.count++;

    if (attempts.count >= 5) {
      attempts.count = 0;
      attempts.blockedUntil = Date.now() + 15 * 60 * 1000;
    }

    ownerAttempts.set(ip, attempts);

    return res.status(401).json({
      status: "ERROR",
      message: "Code administrateur incorrect."
    });
  }

  ownerAttempts.delete(ip);

  try {
    return res.json({
      status: "OK",
      token: createOwnerToken(),
      role: "owner",
      vip: true,
      lifetime: true
    });
  } catch (error) {
    return sendError(res, error);
  }
});

app.get("/api/admin/status", requireOwner, (req, res) => {
  res.json({
    status: "OK",
    authenticated: true,
    role: "owner",
    vip: true
  });
});

// --------------------------------------------------
// ROUTES PROPRIETAIRE
// --------------------------------------------------

app.get("/api/admin/config", requireOwner, (req, res) => {
  res.json({
    status: "OK",
    application: "DRABO73 VIP PRONOS",
    timezone: TIMEZONE,
    footballTokenConfigured: Boolean(getToken()),
    plans: VIP_PLANS
  });
});

// VIDER LE CACHE
app.post("/api/admin/cache/clear", requireOwner, (req, res) => {
  cache.clear();

  res.json({
    status: "OK",
    message: "Cache vidé."
  });
});

// --------------------------------------------------
// ROUTE 404
// --------------------------------------------------

apapp.use((req, res) => {
  res.status(404).json({
    status: "ERROR",
    message: "Route introuvable."
  });
});

// --------------------------------------------------
// GESTION DES ERREURS
// --------------------------------------------------

app.use((error, req, res, next) => {
  console.error("Erreur serveur :", error);

  if (res.headersSent) {
    return next(error);
  }

  res.status(error.status || 500).json({
    status: "ERROR",
    message: error.message || "Une erreur interne est survenue."
  });
});

// --------------------------------------------------
// DEMARRAGE DU SERVEUR
// --------------------------------------------------

app.listen(PORT, "0.0.0.0", () => {
  console.log(`DRABO73 VIP PRONOS actif sur le port ${PORT}`);
});
app.use((req, res) => {
  res.status(404).json({
    status: "ERROR",
    message: "Route introuvable."
  });
});

// --------------------------------------------------
// GESTION DES ERREURS
// --------------------------------------------------

app.use((error, req, res, next) => {
  console.error("Erreur serveur :", error);

  if (res.headersSent) {
    return next(error);
  }

  res.status(error.status || 500).json({
    status: "ERROR",
    message: error.message || "Une erreur interne est survenue."
  });
});

// --------------------------------------------------
// DEMARRAGE DU SERVEUR
// --------------------------------------------------

app.listen(PORT, "0.0.0.0", () => {
  console.log(`DRABO73 VIP PRONOS actif sur le port ${PORT}`);
});
