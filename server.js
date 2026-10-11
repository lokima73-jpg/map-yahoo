// Serveur MCP distant (Streamable HTTP, sans session) pour Yahoo Finance.
// Outils : get_quote, get_history, get_news
// Lancer : npm install puis npm start  (écoute sur le port PORT, 3000 par défaut)
// Adresse à donner à Claude : https://TON-SERVEUR/mcp

import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const PORT = process.env.PORT || 3000;
const UA = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
};
const HOTES = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];

// ---------- Utilitaires ----------
function normaliser(s) {
  s = String(s).trim().toUpperCase();
  const alias = {
    GOLD: "GC=F",
    OR: "GC=F",
    DXY: "DX-Y.NYB",
    XAUUSD: "XAUUSD=X",
    EURUSD: "EURUSD=X",
  };
  if (alias[s]) return alias[s];
  const m = s.match(/^([A-Z]{3})[\/-]([A-Z]{3})$/);
  if (m) return m[1] + m[2] + "=X"; // XAU/USD -> XAUUSD=X, EUR/USD -> EURUSD=X
  return s;
}

async function yahooChart(symbole, range, interval) {
  let derniere;
  for (const h of HOTES) {
    try {
      const url =
        "https://" + h + "/v8/finance/chart/" + encodeURIComponent(symbole) +
        "?range=" + range + "&interval=" + interval;
      const r = await fetch(url, { headers: UA });
      if (!r.ok) throw new Error("Yahoo a répondu " + r.status);
      const j = await r.json();
      const res = j.chart && j.chart.result && j.chart.result[0];
      if (!res) {
        throw new Error((j.chart && j.chart.error && j.chart.error.description) || "Aucune donnée pour " + symbole);
      }
      return res;
    } catch (e) {
      derniere = e;
    }
  }
  throw derniere;
}

const ok = (texte) => ({ content: [{ type: "text", text: texte }] });
const ko = (e) => ({ content: [{ type: "text", text: "Erreur : " + (e && e.message ? e.message : String(e)) }], isError: true });
const arrondi = (n, d = 5) => (n == null ? "" : String(Math.round(n * 10 ** d) / 10 ** d));
const premier = (tab) => (tab || []).find((x) => x != null);

// ---------- Définition des outils ----------
function creerServeur() {
  const server = new McpServer({ name: "yahoo-finance", version: "1.0.0" });

  server.tool(
    "get_quote",
    "Prix en direct d'un instrument Yahoo Finance (ex : XAU/USD, EUR/USD, DXY, AAPL, GC=F). Renvoie une ligne d'en-têtes puis une ligne de valeurs séparées par des points-virgules.",
    { symbol: z.string().describe("Symbole, par ex. XAU/USD, EUR/USD, AAPL, GC=F") },
    async ({ symbol }) => {
      try {
        const s = normaliser(symbol);
        const res = await yahooChart(s, "1d", "5m");
        const m = res.meta;
        const q = (res.indicators && res.indicators.quote && res.indicators.quote[0]) || {};
        const prix = m.regularMarketPrice;
        const prec = m.chartPreviousClose;
        const var_ = prix != null && prec ? prix - prec : null;
        const pct = var_ != null ? (var_ / prec) * 100 : null;
        const entetes = "symbol;name;exchange;datetime;timestamp;open;high;low;close;previous_close;change;percent_change;fifty_two_week_low;fifty_two_week_high";
        const valeurs = [
          s,
          m.longName || m.shortName || s,
          m.exchangeName || "",
          m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString() : "",
          m.regularMarketTime || "",
          arrondi(premier(q.open)),
          arrondi(m.regularMarketDayHigh),
          arrondi(m.regularMarketDayLow),
          arrondi(prix),
          arrondi(prec),
          arrondi(var_),
          arrondi(pct, 4),
          arrondi(m.fiftyTwoWeekLow),
          arrondi(m.fiftyTwoWeekHigh),
        ].join(";");
        return ok(entetes + "\n" + valeurs);
      } catch (e) {
        return ko(e);
      }
    }
  );

  server.tool(
    "get_history",
    "Historique de prix Yahoo Finance, du plus récent au plus ancien, au format datetime;open;high;low;close.",
    {
      symbol: z.string().describe("Symbole, par ex. XAU/USD ou EUR/USD"),
      range: z.enum(["1d", "5d", "1mo", "3mo", "6mo", "1y", "2y", "5y"]).default("1y").describe("Période couverte"),
      interval: z.enum(["5m", "15m", "30m", "1h", "1d", "1wk"]).default("1d").describe("Taille des bougies"),
      limit: z.number().int().min(1).max(1000).default(300).describe("Nombre maximum de lignes"),
    },
    async ({ symbol, range, interval, limit }) => {
      try {
        const s = normaliser(symbol);
        const res = await yahooChart(s, range, interval);
        const ts = res.timestamp || [];
        const q = res.indicators.quote[0];
        const lignes = [];
        for (let i = ts.length - 1; i >= 0 && lignes.length < limit; i--) {
          if (q.close[i] == null) continue;
          const iso = new Date(ts[i] * 1000).toISOString();
          const date = interval === "1d" || interval === "1wk" ? iso.slice(0, 10) : iso.slice(0, 19).replace("T", " ");
          lignes.push([date, arrondi(q.open[i]), arrondi(q.high[i]), arrondi(q.low[i]), arrondi(q.close[i])].join(";"));
        }
        return ok("datetime;open;high;low;close\n" + lignes.join("\n"));
      } catch (e) {
        return ko(e);
      }
    }
  );

  server.tool(
    "get_news",
    "Dernières actualités Yahoo Finance liées à un symbole (titre, date, lien).",
    {
      symbol: z.string().describe("Symbole, par ex. XAU/USD, EUR/USD, GC=F"),
      limit: z.number().int().min(1).max(20).default(10).describe("Nombre d'articles"),
    },
    async ({ symbol, limit }) => {
      try {
        const s = normaliser(symbol);
        const r = await fetch(
          "https://feeds.finance.yahoo.com/rss/2.0/headline?s=" + encodeURIComponent(s) + "&region=US&lang=en-US",
          { headers: UA }
        );
        if (!r.ok) throw new Error("Yahoo a répondu " + r.status);
        const xml = await r.text();
        const get = (bloc, tag) => {
          const m = bloc.match(new RegExp("<" + tag + ">([\\s\\S]*?)</" + tag + ">"));
          return m
            ? m[1]
                .replace(/<!\[CDATA\[|\]\]>/g, "")
                .replace(/&amp;/g, "&")
                .replace(/&#39;|&apos;/g, "'")
                .replace(/&quot;/g, '"')
                .trim()
            : "";
        };
        const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, limit);
        if (!items.length) return ok("Aucune actualité pour " + s);
        const sortie = items.map((i) => get(i[1], "title") + " | " + get(i[1], "pubDate") + " | " + get(i[1], "link"));
        return ok("titre | date | lien\n" + sortie.join("\n"));
      } catch (e) {
        return ko(e);
      }
    }
  );

  return server;
}

// ---------- Serveur HTTP (mode sans session) ----------
const app = express();
app.use(express.json());

app.post("/mcp", async (req, res) => {
  const server = creerServeur();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Erreur interne du serveur" }, id: null });
    }
  }
});

const refuse = (req, res) =>
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Méthode non autorisée." }, id: null });
app.get("/mcp", refuse);
app.delete("/mcp", refuse);

app.get("/", (req, res) => res.type("text").send("Serveur MCP Yahoo Finance actif. Adresse du connecteur : /mcp"));

app.listen(PORT, () => console.log("MCP Yahoo Finance prêt sur le port " + PORT + " (adresse /mcp)"));
