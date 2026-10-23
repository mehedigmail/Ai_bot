

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY;

const genAI = GEMINI_API_KEY
  ? new GoogleGenerativeAI(GEMINI_API_KEY)
  : null;

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    message: "AI Trading Agent backend is running",
    twelveDataConfigured: Boolean(TWELVE_DATA_API_KEY),
    geminiConfigured: Boolean(GEMINI_API_KEY)
  });
});

app.get("/api/analyze", async (req, res) => {
  try {
    if (!TWELVE_DATA_API_KEY || !GEMINI_API_KEY || !genAI) {
      return res.status(503).json({
        error: "API keys are not configured in backend environment variables."
      });
    }

    const allowedSymbols = [
      "EUR/USD",
      "GBP/USD",
      "USD/JPY",
      "AUD/USD",
      "USD/CAD",
      "EUR/GBP"
    ];

    const symbol = String(req.query.symbol || "EUR/USD");

    if (!allowedSymbols.includes(symbol)) {
      return res.status(400).json({ error: "Unsupported currency pair." });
    }

    const url = new URL("https://api.twelvedata.com/time_series");
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("interval", "1min");
    url.searchParams.set("outputsize", "100");
    url.searchParams.set("apikey", TWELVE_DATA_API_KEY);

    const marketResponse = await fetch(url);

    if (!marketResponse.ok) {
      throw new Error("Market data provider request failed.");
    }

    const marketData = await marketResponse.json();

    if (
      marketData.status === "error" ||
      !Array.isArray(marketData.values) ||
      marketData.values.length < 30
    ) {
      return res.status(502).json({
        error: marketData.message ||
          "Insufficient market candles received. Check API access and quota."
      });
    }

    // Twelve Data usually returns candles newest first.
    const candles = marketData.values
      .slice()
      .reverse()
      .map(c => ({
        time: c.datetime,
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close)
      }));

    if (candles.some(c =>
      !Number.isFinite(c.close) ||
      !Number.isFinite(c.high) ||
      !Number.isFinite(c.low) ||
      !Number.isFinite(c.open)
    )) {
      throw new Error("Market data contains invalid prices.");
    }

    const closes = candles.map(c => c.close);

    function ema(values, period) {
      const multiplier = 2 / (period + 1);
      let result = values[0];

      for (let i = 1; i < values.length; i++) {
        result = values[i] * multiplier +
          result * (1 - multiplier);
      }

      return result;
    }

    function calculateRSI(values, period = 14) {
      if (values.length <= period) return null;

      let gains = 0;
      let losses = 0;

      for (let i = 1; i <= period; i++) {
        const change = values[i] - values[i - 1];

        if (change > 0) gains += change;
        else losses -= change;
      }

      let avgGain = gains / period;
      let avgLoss = losses / period;

      for (let i = period + 1; i < values.length; i++) {
        const change = values[i] - values[i - 1];
        const gain = Math.max(change, 0);
        const loss = Math.max(-change, 0);

        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;
      }

      if (avgLoss === 0) return 100;

      return 100 - 100 / (1 + avgGain / avgLoss);
    }

    const last = closes[closes.length - 1];
    const rsi = calculateRSI(closes, 14);
    const ema9 = ema(closes.slice(-40), 9);
    const ema21 = ema(closes.slice(-60), 21);

    const emaTrend = ema9 > ema21
      ? "Bullish"
      : ema9 < ema21
        ? "Bearish"
        : "Neutral";

    const macdLine = ema(closes.slice(-35), 12) -
      ema(closes.slice(-35), 26);

    const previous = closes[closes.length - 2];

    const marketSummary = {
      symbol,
      interval: "1min",
      latestCandleTime: candles[candles.length - 1].time,
      latestPrice: last,
      previousClose: previous,
      rsi: Number(rsi.toFixed(2)),
      ema9: Number(ema9.toFixed(6)),
      ema21: Number(ema21.toFixed(6)),
      emaTrend,
      macdLine: Number(macdLine.toFixed(8)),
      recentCandles: candles.slice(-20)
    };

    const model = genAI.getGenerativeModel({
      model: process.env.GEMINI_MODEL || "gemini-2.5-flash"
    });

    const prompt = `
You are a cautious financial market analysis assistant.

Analyze this real-market one-minute candle data.
Do not claim certainty or guarantee a profitable trade.
Do not invent data or imply you can see future prices.

Return ONLY valid JSON with these fields:
{
  "signal": "BUY" or "SELL" or "WAIT",
  "confidence": integer from 0 to 100,
  "trend": "Bullish", "Bearish", or "Neutral",
  "rsiStatus": "Oversold", "Overbought", or "Neutral",
  "reason": "brief explanation"
}

Use BUY or SELL only when evidence is reasonably aligned.
Use WAIT when evidence is mixed or weak.
Confidence represents analytical confidence, NOT probability of winning.
The candles may include the currently forming candle; account for this limitation.

Market data:
${JSON.stringify(marketSummary)}
`;

    const result = await model.generateContent(prompt);
    const answer = result.response.text();

    const jsonText = answer
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();

    const analysis = JSON.parse(jsonText);

    if (!["BUY", "SELL", "WAIT"].includes(analysis.signal)) {
      throw new Error("AI returned an invalid signal.");
    }

    const confidence = Number(analysis.confidence);

    if (!Number.isFinite(confidence)) {
      throw new Error("AI returned invalid confidence.");
    }

    res.json({
      symbol,
      price: last,
      rsi: Number(rsi.toFixed(2)),
      emaTrend,
      macdTrend: macdLine > 0 ? "Positive" :
        macdLine < 0 ? "Negative" : "Neutral",
      trend: analysis.trend,
      rsiStatus: rsi < 30 ? "Oversold" :
        rsi > 70 ? "Overbought" : "Neutral",
      signal: analysis.signal,
      confidence: Math.max(0, Math.min(100, confidence)),
      reason: String(analysis.reason || "Analysis completed."),
      candleTime: candles[candles.length - 1].time,
      analyzedAt: new Date().toISOString()
    });

  } catch (error) {
    console.error("Analysis error:", error.message);

    res.status(502).json({
      error: "Analysis failed. Check backend logs, API access and quotas."
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`AI Trading Agent server running on port ${PORT}`);
});
