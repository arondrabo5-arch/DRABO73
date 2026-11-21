
import express from "express";
import crypto from "crypto";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;

const API_BASE = "https://api.football-data.org/v4";
const TIMEZONE = "Africa/Ouagadougou";

const MAX_PERIOD_DAYS = 10;
const HISTORY_REQUIRED = 3;
const HISTORY_TARGET = 5;
const HISTORY_MAX_DAYS = 365;

const OWNER_ACCESS_CODE = process.env.OWNER_ACCESS_CODE || "";
const OWNER_TOKEN_SECRET = process.env.OWNER_TOKEN_SECRET || "";

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// CORS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Protection des tentatives propriétaire
const ownerAttempts = new Map();

function createOwnerToken() {
  const payload = Buffer.from(JSON.stringify({
    role: "owner",
    exp: Date.now() + 30 * 86400000
  })).toString("base64url");

  const signature = crypto
    .createHmac("sha256", OWNER_TOKEN_SECRET)
    .update(payload)
    .digest("base64url");

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
    .digest("base64url");

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);

  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return false;
  }

  try {
    const data = JSON.parse(
      Buffer.from(payload, "base64url").toString()
    );

    return data.role === "owner" && Number(data.exp) > Date.now();
  } catch {
    return false;
  }
}

function getBearerToken(req) {
  const authorization = String(req.headers.authorization || "");

  return authorization.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";
}

function requireOwner(req, res, next) {
  if (!verifyOwnerToken(getBearerToken(req))) {
    return res.status(401).json({
      status: "ERROR",
      message: "Accès propriétaire non valide."
    });
  }

  next();
}

// Clé football-data.org
function getToken() {
  return (
    process.env.FOOTBALL_DATA_API_KEY ||
    process.env.FOOTBALL_DATA_API_TOKEN ||
    process.env.FOOTBALL_DATA_TOKEN ||
    ""
  ).trim();
}

// Date du Burkina Faso
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

function addDays(dateString, amount) {
  const date = new Date(`${dateString}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) {
    return false;
  }

  const date = new Date(`${value}T00:00:00Z`);

  return !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value;
}

function daysBetween(from, to) {
  return Math.round(
    (new Date(`${to}T00:00:00Z`) -
      new Date(`${from}T00:00:00Z`)) / 86400000
  );
}

function validatePeriod(from, to, maximum = MAX_PERIOD_DAYS) {
  if (!validDate(from) || !validDate(to)) {
    return "Dates invalides. Format attendu : YYYY-MM-DD.";
  }

  if (from > to) {
    return "La date de début doit précéder la date de fin.";
  }

  if (daysBetween(from, to) > maximum) {
    return `La période ne doit pas dépasser ${maximum} jours.`;
  }

  return null;
}

function sortMatches(matches) {
  return matches.sort(
    (a, b) => new Date(a.utcDate) - new Date(b.utcDate)
  );
}

function sendError(res, error) {
  console.error("API error:", error);

  return res.status(error.status || 500).json({
    status: "ERROR",
    message: error.message || "Erreur interne du serveur.",
    apiStatus: error.status || 500
  });
}

// Connexion à football-data.org
async function footballRequest(endpoint, query = {}) {
  const token = getToken();

  if (!token) {
    const error = new Error(
      "Clé API football-data.org non configurée sur Render."
    );
    error.status = 503;
    throw error;
  }

  const url = new URL(`${API_BASE}${endpoint}`);

  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);

  try {
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "X-Auth-Token": token,
        "Accept": "application/json"
      },
      signal: controller.signal
    });

    const raw = await response.text();
    let data = {};

    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      data = { message: "Réponse API illisible." };
    }

    if (!response.ok) {
      const error = new Error(
        data.message || data.error || "Erreur football-data.org."
      );
      error.status = response.status;
      throw error;
    }

    return data;
  } catch (error) {
    if (error.name === "AbortError") {
      const e = new Error("Délai de connexion dépassé.");
      e.status = 504;
      throw e;
    }

    if (error.status) throw error;

    const e = new Error("Impossible de contacter football-data.org.");
    e.status = 502;
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

async function sendFootball(res, endpoint, query = {}) {
  try {
    const data = await footballRequest(endpoint, query);

    return res.json({
      status: "OK",
      source: "football-data.org API V4",
      ...data
    });
  } catch (error) {
    return sendError(res, error);
  }
}

// Recherche découpée en périodes de 10 jours
async function fetchMatchesInPeriod(endpoint, from, to, extra = {}) {
  const matches = [];
  let cursor = from;

  while (cursor <= to) {
    const chunkEnd = addDays(cursor, 9);
    const end = chunkEnd > to ? to : chunkEnd;

    const data = await footballRequest(endpoint, {
      ...extra,
      dateFrom: cursor,
      dateTo: end
    });

    if (Array.isArray(data.matches)) {
      matches.push(...data.matches);
    }

    cursor = addDays(end, 1);
  }

  const unique = [...new Map(
    matches.map(match => [match.id, match])
  ).values()];

  return sortMatches(unique);
}

// Statistiques officielles d'une équipe
function calculateTeamStats(teamId, matches) {
  let played = 0;
  let wins = 0;
  let draws = 0;
  let losses = 0;
  let goalsFor = 0;
  let goalsAgainst = 0;
  let cleanSheets = 0;
  let failedToScore = 0;

  for (const match of matches) {
    const homeId = Number(match.homeTeam?.id);
    const awayId = Number(match.awayTeam?.id);
    const homeScore = match.score?.fullTime?.home;
    const awayScore = match.score?.fullTime?.away;

    if (
      !Number.isInteger(homeScore) ||
      !Number.isInteger(awayScore)
    ) {
      continue;
    }

    let scored;
    let conceded;

    if (homeId === Number(teamId)) {
      scored = homeScore;
      conceded = awayScore;
    } else if (awayId === Number(teamId)) {
      scored = awayScore;
      conceded = homeScore;
    } else {
      continue;
    }

    played++;
    goalsFor += scored;
    goalsAgainst += conceded;

    if (scored > conceded) wins++;
    else if (scored === conceded) draws++;
    else losses++;

    if (conceded === 0) cleanSheets++;
    if (scored === 0) failedToScore++;
  }

  return {
    played,
    wins,
    draws,
    losses,
    goalsFor,
    goalsAgainst,
    goalsForAverage: played
      ? Number((goalsFor / played).toFixed(2))
      : null,
    goalsAgainstAverage: played
      ? Number((goalsAgainst / played).toFixed(2))
      : null,
    cleanSheets,
    failedToScore,
    dataSource: "Scores officiels football-data.org"
  };
}

// Derniers matchs terminés d'une équipe
async function getRecentTeamMatches(teamId) {
  const today = getBurkinaDate();
  const oldestDate = addDays(today, -HISTORY_MAX_DAYS);
  const allMatches = new Map();

  let periodEnd = today;

  while (
    periodEnd >= oldestDate &&
    allMatches.size < HISTORY_TARGET
  ) {
    let periodStart = addDays(periodEnd, -9);

    if (periodStart < oldestDate) {
      periodStart = oldestDate;
    }

    const data = await footballRequest(`/teams/${teamId}/matches`, {
      status: "FINISHED",
      dateFrom: periodStart,
      dateTo: periodEnd,
      limit: 100
    });

    for (const match of data.matches || []) {
      if (match.id) {
        allMatches.set(match.id, match);
      }
    }

    periodEnd = addDays(periodStart, -1);
  }

  return [...allMatches.values()]
    .filter(match => {
      const home = Number(match.homeTeam?.id);
      const away = Number(match.awayTeam?.id);

      return (
        match.status === "FINISHED" &&
        (home === Number(teamId) || away === Number(teamId)) &&
        Number.isInteger(match.score?.fullTime?.home) &&
        Number.isInteger(match.score?.fullTime?.away)
      );
    })
    .sort((a, b) => new Date(b.utcDate) - new Date(a.utcDate))
    .slice(0, HISTORY_TARGET);
}

// Modèle de Poisson
function poisson(lambda, goals) {
  let factorial = 1;

  for (let i = 2; i <= goals; i++) {
    factorial *= i;
  }

  return Math.exp(-lambda) * Math.pow(lambda, goals) / factorial;
}

function calculatePrediction(homeStats, awayStats) {
  const homeLambda = Math.max(
    0.15,
    Math.min(4.5, (
      homeStats.goalsForAverage +
      awayStats.goalsAgainstAverage
    ) / 2)
  );

  const awayLambda = Math.max(
    0.15,
    Math.min(4.5, (
      awayStats.goalsForAverage +
      homeStats.goalsAgainstAverage
    ) / 2)
  );

  const scores = [];
  let homeWin = 0;
  let draw = 0;
  let awayWin = 0;

  for (let h = 0; h <= 6; h++) {
    for (let a = 0; a <= 6; a++) {
      const probability =
        poisson(homeLambda, h) * poisson(awayLambda, a);

      scores.push({
        home: h,
        away: a,
        probability
      });

      if (h > a) homeWin += probability;
      else if (h === a) draw += probability;
      else awayWin += probability;
    }
  }

  const total = homeWin + draw + awayWin;

  homeWin /= total;
  draw /= total;
  awayWin /= total;

  const sortedScores = scores
    .sort((a, b) => b.probability - a.probability)
    .slice(0, 3)
    .map(score => ({
      score: `${score.home}-${score.away}`,
      probability: Number(
        (score.probability / total * 100).toFixed(1)
      )
    }));

  return {
    expectedGoals: {
      home: Number(homeLambda.toFixed(2)),
      away: Number(awayLambda.toFixed(2))
    },
    probabilities: {
      homeWin: Number((homeWin * 100).toFixed(1)),
      draw: Number((draw * 100).toFixed(1)),
      awayWin: Number((awayWin * 100).toFixed(1)),
      doubleChance1X: Number(
        ((homeWin + draw) * 100).toFixed(1)
      ),
      doubleChanceX2: Number(
        ((awayWin + draw) * 100).toFixed(1)
      )
    },
    exactScores: sortedScores,
    model: "Modèle statistique de Poisson",
    warning: "Estimations statistiques, jamais des garanties."
  };
}

// Connexion propriétaire : VIP et analyses gratuits
app.post("/api/owner/access", (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();

  const attempts = ownerAttempts.get(ip) || {
    count: 0,
    start: now,
    blockedUntil: 0
  };

  if (attempts.blockedUntil > now) {
    return res.status(429).json({
      status: "ERROR",
      message: "Trop de tentatives. Réessaie plus tard."
    });
  }

  if (now - attempts.start > 15 * 60 * 1000) {
    attempts.count = 0;
    attempts.start = now;
    attempts.blockedUntil = 0;
  }

  if (!OWNER_ACCESS_CODE || !OWNER_TOKEN_SECRET) {
    return res.status(503).json({
      status: "ERROR",
      message: "Accès propriétaire non configuré sur Render."
    });
  }

  const code = String(req.body?.code || "");
  const supplied = Buffer.from(code);
  const expected = Buffer.from(OWNER_ACCESS_CODE);

  const valid =
    supplied.length === expected.length &&
    crypto.timingSafeEqual(supplied, expected);

  if (!valid) {
    attempts.count++;

    if (attempts.count >= 5) {
      attempts.blockedUntil = now + 15 * 60 * 1000;
    }

    ownerAttempts.set(ip, attempts);

    return res.status(401).json({
      status: "ERROR",
      message: "Code propriétaire incorrect."
    });
  }

  ownerAttempts.delete(ip);

  return res.json({
    status: "OK",
    role: "owner",
    token: createOwnerToken(),
    vip: true,
    analysis: true,
    paymentRequired: false,
    message: "Accès propriétaire activé."
  });
});

app.get("/api/owner/verify", requireOwner, (req, res) => {
  return res.json({
    status: "OK",
    role: "owner",
    vip: true,
    analysis: true,
    paymentRequired: false
  });
});

// Santé du serveur
app.get("/health", (req, res) => {
  return res.json({
    status: "OK",
    application: "DRABO73 VIP PRONOS",
    message: "Serveur actif",
    time: new Date().toISOString()
  });
});

// État des connexions
app.get("/api/status", (req, res) => {
  return res.json({
    status: "OK",
    application: "DRABO73 VIP PRONOS",
    footballDataConfigured: Boolean(getToken()),
    ownerAccessConfigured: Boolean(
      OWNER_ACCESS_CODE && OWNER_TOKEN_SECRET
    ),
    footballDataSource: "football-data.org API V4",
    dateBurkina: getBurkinaDate(),
    maximumPeriodDays: MAX_PERIOD_DAYS,
    historyRequired: HISTORY_REQUIRED,
    historyTarget: HISTORY_TARGET,
    analysisModel: "Poisson",
    realDataOnly: true
  });
});

// Matchs du jour ou dates demandées
app.get("/api/matches", async (req, res) => {
  const today = getBurkinaDate();
  const dateFrom = req.query.dateFrom || today;
  const dateTo = req.query.dateTo || today;

  const error = validatePeriod(dateFrom, dateTo);

  if (error) {
    return res.status(400).json({
      status: "ERROR",
      message: error
    });
  }

  return sendFootball(res, "/matches", {
    ...req.query,
    dateFrom,
    dateTo
  });
});

// Matchs à venir
app.get("/api/matches/upcoming", async (req, res) => {
  const today = getBurkinaDate();
  const dateFrom = req.query.dateFrom || today;
  const dateTo = req.query.dateTo || addDays(today, 9);

  const error = validatePeriod(dateFrom, dateTo);

  if (error) {
    return res.status(400).json({
      status: "ERROR",
      message: error
    });
  }

  return sendFootball(res, "/matches", {
    ...req.query,
    dateFrom,
    dateTo
  });
});

// Historique global des résultats officiels
app.get("/api/matches/history", async (req, res) => {
  try {
    const today = getBurkinaDate();
    const dateFrom = req.query.dateFrom || addDays(today, -30);
    const dateTo = req.query.dateTo || today;

    const error = validatePeriod(
      dateFrom,
      dateTo,
      HISTORY_MAX_DAYS
    );

    if (error) {
      return res.status(400).json({
        status: "ERROR",
        message: error
      });
    }

    const matches = await fetchMatchesInPeriod(
      "/matches",
      dateFrom,
      dateTo,
      { status: "FINISHED" }
    );

    const finished = matches.filter(
      match => match.status === "FINISHED"
    );

    return res.json({
      status: "OK",
      source: "football-data.org API V4",
      application: "DRABO73 VIP PRONOS",
      total: finished.length,
      dateFrom,
      dateTo,
      matches: finished
    });
  } catch (error) {
    return sendError(res, error);
  }
});

// Période personnalisée
app.get("/api/matches/period", async (req, res) => {
  const dateFrom = req.query.dateFrom;
  const dateTo = req.query.dateTo;

  const error = validatePeriod(dateFrom, dateTo);

  if (error) {
    return res.status(400).json({
      status: "ERROR",
      message: error
    });
  }

  return sendFootball(res, "/matches", {
    ...req.query,
    dateFrom,
    dateTo
  });
});

// Cinq derniers matchs d'une équipe
app.get("/api/teams/:id/recent-matches", async (req, res) => {
  const teamId = String(req.params.id);

  if (!/^\d+$/.test(teamId)) {
    return res.status(400).json({
      status: "ERROR",
      message: "Identifiant équipe invalide."
    });
  }

  try {
    const matches = await getRecentTeamMatches(teamId);
    const statistics = calculateTeamStats(teamId, matches);
    const sufficient = matches.length >= HISTORY_REQUIRED;

    return res.json({
      status: "OK",
      source: "football-data.org API V4",
      teamId: Number(teamId),
      total: matches.length,
      minimumRequired: HISTORY_REQUIRED,
      target: HISTORY_TARGET,
      sufficient,
      statistics,
      message: sufficient
        ? "Historique récupéré."
        : `Historique insuffisant : ${matches.length} match(s) terminé(s) avec score disponible.`,
      matches
    });
  } catch (error) {
    return sendError(res, error);
  }
});

// Analyse automatique d'un match
app.get("/api/matches/:id/analysis", async (req, res) => {
  const matchId = String(req.params.id);

  if (!/^\d+$/.test(matchId)) {
    return res.status(400).json({
      status: "ERROR",
      message: "Identifiant de match invalide."
    });
  }

  try {
    const matchData = await footballRequest(`/matches/${matchId}`);
    const match = matchData.match || matchData;

    const homeId = match.homeTeam?.id;
    const awayId = match.awayTeam?.id;

    if (!homeId || !awayId) {
      return res.status(422).json({
        status: "ERROR",
        message: "Identifiants des deux équipes indisponibles."
      });
    }

    const [homeMatches, awayMatches] = await Promise.all([
      getRecentTeamMatches(homeId),
      getRecentTeamMatches(awayId)
    ]);

    const homeStats = calculateTeamStats(homeId, homeMatches);
    const awayStats = calculateTeamStats(awayId, awayMatches);

    const sufficient =
      homeMatches.length >= HISTORY_REQUIRED &&
      awayMatches.length >= HISTORY_REQUIRED;

    const common = {
      status: "OK",
      source: "football-data.org API V4",
      match: {
        id: match.id,
        date: match.utcDate,
        status: match.status,
        competition: match.competition?.name || null,
        homeTeam: match.homeTeam?.name || null,
        awayTeam: match.awayTeam?.name || null
      },
      history: {
        home: homeMatches.length,
        away: awayMatches.length,
        minimumRequired: HISTORY_REQUIRED,
        target: HISTORY_TARGET
      }
    };

    if (!sufficient) {
      return res.json({
        ...common,
        sufficient: false,
        message: "Historique insuffisant pour une analyse fiable.",
        homeStatistics: homeStats,
        awayStatistics: awayStats,
        prediction: null,
        unavailableData: [
          "Probabilités de buts",
          "Scores exacts",
          "Double chance",
          "Confiance statistique"
        ]
      });
    }

    const prediction = calculatePrediction(
      homeStats,
      awayStats
    );

    return res.json({
      ...common,
      sufficient: true,
      message: "Analyse statistique terminée.",
      homeStatistics: homeStats,
      awayStatistics: awayStats,
      prediction,
      disclaimer:
        "Pronostics statistiques basés sur les résultats officiels. Aucun résultat n'est garanti."
    });
  } catch (error) {
    return sendError(res, error);
  }
});

// Page principale
app.get("/", (req, res) => {
  return res.json({
    status: "OK",
    application: "DRABO73 VIP PRONOS",
    slogan: "LA CONFIANCE RESTE",
    message: "Serveur actif",
    source: "football-data.org API V4"
 