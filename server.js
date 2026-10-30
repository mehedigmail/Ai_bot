
const express = require("express");
const path = require("path");

const app = express();

app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

const OTC_KEY = process.env.OTCHARTS_API_KEY;
const GROQ_KEY = process.env.GROQ_API_KEY;

const MODEL =
  process.env.GROQ_MODEL || "openai/gpt-oss-20b";

const OTC_BASE = "https://otcharts.com";

const SYMBOLS = {
  EURUSD_otc: "EUR/USD OTC",
  GBPUSD_otc: "GBP/USD OTC",
  USDJPY_otc: "USD/JPY OTC",
  BTCUSD_otc: "BTC/USD OTC",
  AUDUSD_otc: "AUD/USD OTC"
};

// Error response
function sendError(res, status, message) {
  return res.status(status).json({
    ok: false,
    error: message
  });
}

// OTCharts API connection
async function getOTCData(endpoint) {
  if (!OTC_KEY) {
    throw new Error(
      "OTCHARTS_API_KEY is missing in Render Environment."
    );
  }

  const response = await fetch(
    OTC_BASE + endpoint,
    {
      headers: {
        Authorization: `Bearer ${OTC_KEY}`,
        Accept: "application/json"
      },
      signal: AbortSignal.timeout(15000)
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      data.error || `OTCharts API Error: ${response.status}`
    );
  }

  return data;
}

// EMA calculation
function calculateEMA(values, period) {
  if (values.length < period) return null;

  const multiplier = 2 / (period + 1);

  let result =
    values.slice(0, period).reduce((a, b) => a + b, 0) /
    period;

  for (let i = period; i < values.length; i++) {
    result =
      values[i] * multiplier +
      result * (1 - multiplier);
  }

  return result;
}

// RSI calculation
function calculateRSI(values, period = 14) {
  if (values.length <= period) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const difference = values[i] - values[i - 1];

    if (difference > 0) gains += difference;
    else losses -= difference;
  }

  let averageGain = gains / period;
  let averageLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {
    const difference = values[i] - values[i - 1];

    averageGain =
      (averageGain * (period - 1) +
        Math.max(difference, 0)) / period;

    averageLoss =
      (averageLoss * (period - 1) +
        Math.max(-difference, 0)) / period;
  }

  if (averageLoss === 0) return 100;

  const rs = averageGain / averageLoss;

  return 100 - 100 / (1 + rs);
}

// Technical indicators
function calculateIndicators(candles) {
  const closes = candles.map(c => Number(c.close));

  const rsi = calculateRSI(closes, 14);

  const ema9 = calculateEMA(closes, 9);
  const ema21 = calculateEMA(closes, 21);

  const ema12 = calculateEMA(closes, 12);
  const ema26 = calculateEMA(closes, 26);

  const macd =
    ema12 === null || ema26 === null
      ? null
      : ema12 - ema26;

  return {
    rsi:
      rsi === null
        ? null
        : Number(rsi.toFixed(2)),

    emaTrend:
      ema9 === null || ema21 === null
        ? "insufficient_data"
        : ema9 > ema21
        ? "bullish"
        : ema9 < ema21
        ? "bearish"
        : "neutral",

    macd:
      macd === null
        ? null
        : Number(macd.toPrecision(8)),

    macdTrend:
      macd === null
        ? "insufficient_data"
        : macd > 0
        ? "bullish"
        : macd < 0
        ? "bearish"
        : "neutral"
  };
}

// Groq AI analysis
async function analyzeWithGroq(marketData) {
  if (!GROQ_KEY) {
    throw new Error(
      "GROQ_API_KEY is missing in Render Environment."
    );
  }

  const response = await fetch(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",

      headers: {
        Authorization: `Bearer ${GROQ_KEY}`,
        "Content-Type": "application/json"
      },

      body: JSON.stringify({
        model: MODEL,
        temperature: 0.1,
        max_tokens: 350,

        response_format: {
          type: "json_object"
        },

        messages: [
          {
            role: "system",
            content: `
You are a careful OTC market analyst.

Analyze ONLY the supplied market candles
and technical indicators.

Return valid JSON with these fields:

{
  "signal": "BUY, SELL or WAIT",
  "confidence": 0,
  "trend": "Bullish, Bearish, Sideways or Unclear",
  "reason": "Short explanation",
  "risk_note": "Risk warning"
}

Rules:
- Never invent market data.
- Never guarantee profit.
- If data is insufficient, choose WAIT.
- If indicators conflict, choose WAIT.
- Confidence is NOT win probability.
- Never claim certainty.
`
          },

          {
            role: "user",
            content: JSON.stringify(marketData)
          }
        ]
      }),

      signal: AbortSignal.timeout(25000)
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      data.error?.message ||
      `Groq API Error: ${response.status}`
    );
  }

  const content =
    data.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("Groq returned an empty response.");
  }

  const result = JSON.parse(content);

  if (!["BUY", "SELL", "WAIT"].includes(result.signal)) {
    result.signal = "WAIT";
  }

  result.confidence = Math.max(
    0,
    Math.min(100, Number(result.confidence) || 0)
  );

  return result;
}

// Backend health check
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "OTC Pulse AI Trading Agent",
    otcConfigured: Boolean(OTC_KEY),
    groqConfigured: Boolean(GROQ_KEY),
    model: MODEL,
    venue: "quotex"
  });
});

// Available OTC symbols
app.get("/api/symbols", async (req, res) => {
  try {
    const data = await getOTCData(
      "/v1/symbols?venue=quotex"
    );

    res.json({
      ok: true,
      ...data
    });

  } catch (error) {
    sendError(res, 502, error.message);
  }
});

// Main market analysis
app.post("/api/analyze", async (req, res) => {
  try {
    const symbol = String(
      req.body.symbol || "EURUSD_otc"
    );

    if (!SYMBOLS[symbol]) {
      return sendError(
        res,
        400,
        "Unsupported OTC market symbol."
      );
    }

    if (!OTC_KEY) {
      return sendError(
        res,
        503,
        "OTCHARTS_API_KEY is missing in Render Environment."
      );
    }

    if (!GROQ_KEY) {
      return sendError(
        res,
        503,
        "GROQ_API_KEY is missing in Render Environment."
      );
    }

    // Request 120 one-minute candles
    const params = new URLSearchParams({
      venue: "quotex",
      symbol: symbol,
      tf: "60",
      limit: "120"
    });

    const market = await getOTCData(
      "/v1/candles?" + params.toString()
    );

    const candles = market.candles || [];

    // Insufficient data
    if (candles.length < 35) {
      return res.json({
        ok: true,
        signal: "WAIT",
        confidence: 0,
        trend: "Unclear",
        reason: "Not enough candle data.",
        symbol,
        pair: SYMBOLS[symbol],
        price: candles.at(-1)?.close ?? null,
        indicators: {},
        dataStatus: "insufficient_data",
        analysisTime: new Date().toISOString()
      });
    }

    // Avoid analysis when candle data has gaps
    if (
      market.gaps?.runs > 0 ||
      market.gaps?.missingBars > 0
    ) {
      return res.json({
        ok: true,
        signal: "WAIT",
        confidence: 0,
        trend: "Unclear",
        reason: "Market candle data contains gaps.",
        symbol,
        pair: SYMBOLS[symbol],
        price: candles.at(-1).close,
        indicators: calculateIndicators(candles),
        dataStatus: "gapped_data",
        analysisTime: new Date().toISOString()
      });
    }

    const indicators =
      calculateIndicators(candles);

    const latestCandle = candles.at(-1);

    // Send actual market data to Groq
    const ai = await analyzeWithGroq({
      venue: "Quotex OTC",
      symbol: symbol,
      timeframe: "1 minute",
      latestCandle,
      previousCandle: candles.at(-2),
      indicators,
      recentCandles: candles.slice(-40)
    });

    res.json({
      ok: true,

      signal: ai.signal,
      confidence: ai.confidence,
      trend: ai.trend || "Unclear",
      reason: ai.reason || "No explanation.",
      riskNote: ai.risk_note || "Signals are estimates only.",

      symbol,
      pair: SYMBOLS[symbol],

      price: Number(latestCandle.close),

      indicators,

      dataStatus: "connected",

      analysisTime: new Date().toISOString(),

      expiryReference: "1 minute"
    });

  } catch (error) {
    console.error("Analysis failed:", error);

    sendError(
      res,
      502,
      error.message || "Market analysis failed."
    );
  }
});

// Frontend
app.get("*", (req, res) => {
  res.sendFile(
    path.join(__dirname, "public", "index.html")
  );
});

// Start server
app.listen(PORT, () => {
  console.log(
    `OTC Pulse AI Trading Agent running on port ${PORT}`
  );
});
    
