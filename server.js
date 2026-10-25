
require("dotenv").config();

const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const CLAUDE_API_KEY = process.env.ANTHROPIC_API_KEY;
const CLAUDE_MODEL =
  process.env.CLAUDE_MODEL || "claude-sonnet-4-6";

const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY;
const MIN_CONFIDENCE = 80;

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    message: "AI Trading Agent backend is running",
    twelveDataConfigured: Boolean(TWELVE_DATA_API_KEY),
    claudeConfigured: Boolean(CLAUDE_API_KEY),
    model: CLAUDE_MODEL,
    minimumConfidence: MIN_CONFIDENCE
  });
});

app.get("/api/analyze", async (req, res) => {
  try {
    if (!TWELVE_DATA_API_KEY || !CLAUDE_API_KEY) {
      return res.status(503).json({
        error:
          "ANTHROPIC_API_KEY or TWELVE_DATA_API_KEY is missing in Render Environment."
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
      return res.status(400).json({
        error: "Unsupported currency pair."
      });
    }

    // Fetch market candles from Twelve Data.
    const url = new URL(
      "https://api.twelvedata.com/time_series"
    );

    url.searchParams.set("symbol", symbol);
    url.searchParams.set("interval", "1min");
    url.searchParams.set("outputsize", "100");
    url.searchParams.set("apikey", TWELVE_DATA_API_KEY);

    const marketResponse = await fetch(url);
    const marketData = await marketResponse.json();

    if (
      !marketResponse.ok ||
      marketData.status === "error" ||
      !Array.isArray(marketData.values)
    ) {
      console.error(
        "Twelve Data error:",
        marketData.message || marketResponse.status
      );

      return res.status(502).json({
        error:
          marketData.message ||
          "Market data request failed. Check Twelve Data API access and quota."
      });
    }

    if (marketData.values.length < 60) {
      return res.status(502).json({
        error: "Insufficient market candles received."
      });
    }

    // Twelve Data normally returns newest candle first.
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

    if (
      candles.some(c =>
        !Number.isFinite(c.open) ||
        !Number.isFinite(c.high) ||
        !Number.isFinite(c.low) ||
        !Number.isFinite(c.close) ||
        c.high < c.low ||
        c.high < Math.max(c.open, c.close) ||
        c.low > Math.min(c.open, c.close)
      )
    ) {
      throw new Error("Invalid market candle data.");
    }

    const closes = candles.map(c => c.close);

    function ema(values, period) {
      const multiplier = 2 / (period + 1);
      let result = values[0];

      for (let i = 1; i < values.length; i++) {
        result =
          values[i] * multiplier +
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
        gains += Math.max(change, 0);
        losses += Math.max(-change, 0);
      }

      let avgGain = gains / period;
      let avgLoss = losses / period;

      for (let i = period + 1; i < values.length; i++) {
        const change = values[i] - values[i - 1];

        avgGain =
          (avgGain * (period - 1) +
            Math.max(change, 0)) / period;

        avgLoss =
          (avgLoss * (period - 1) +
            Math.max(-change, 0)) / period;
      }

      if (avgGain === 0 && avgLoss === 0) return 50;
      if (avgLoss === 0) return 100;
      if (avgGain === 0) return 0;

      return 100 - 100 / (1 + avgGain / avgLoss);
    }

    const last = closes[closes.length - 1];
    const previous = closes[closes.length - 2];

    const rsi = calculateRSI(closes, 14);
    const ema9 = ema(closes, 9);
    const ema21 = ema(closes, 21);

    const emaTrend =
      ema9 > ema21 ? "Bullish" :
      ema9 < ema21 ? "Bearish" : "Neutral";

    // Calculate MACD line using the same close-price series.
    const macdLine = ema(closes, 12) - ema(closes, 26);

    const macdTrend =
      macdLine > 0 ? "Positive" :
      macdLine < 0 ? "Negative" : "Neutral";

    const recentCandles = candles.slice(-20);

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
      macdTrend,
      recentCandles
    };

    const prompt = `
You are a cautious market-data analysis assistant.

Analyze the supplied currency-market data.
Do not guarantee profit, invent data, or claim certainty.

Return ONLY valid JSON in this structure:
{
  "signal": "WAIT",
  "confidence": 0,
  "trend": "Neutral",
  "rsiStatus": "Neutral",
  "reason": "Brief explanation"
}

Rules:
- signal must be BUY, SELL, or WAIT.
- confidence must be an integer from 0 to 100.
- Confidence is an analytical score, NOT a measured win probability.
- trend must be Bullish, Bearish, or Neutral.
- rsiStatus must be Oversold, Overbought, or Neutral.
- Use BUY only when the evidence supports an upward setup.
- Use SELL only when the evidence supports a downward setup.
- Use WAIT when evidence is weak, mixed, or uncertain.
- Do not treat one indicator as proof.
- Do not assume the next candle's direction is known.
- Return JSON only, without Markdown.

Market data:
${JSON.stringify(marketSummary)}
`;

    // Call Claude Messages API.
    const claudeResponse = await fetch(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": CLAUDE_API_KEY,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model: CLAUDE_MODEL,
          max_tokens: 400,
          temperature: 0,
          system:
            "Analyze financial market data cautiously. Never guarantee a result. Return valid JSON only.",
          messages: [
            {
              role: "user",
              content: prompt
            }
          ]
        })
      }
    );

    const claudeData = await claudeResponse.json();

    if (!claudeResponse.ok) {
      console.error(
        "Claude API error:",
        JSON.stringify(claudeData)
      );

      return res.status(502).json({
        error:
          claudeData.error?.message ||
          "Claude API request failed. Check API key, model access, billing and rate limits."
      });
    }

    const answer = (claudeData.content || [])
      .filter(block => block.type === "text")
      .map(block => block.text)
      .join("\n")
      .trim();

    if (!answer) {
      throw new Error("Claude returned an empty response.");
    }

    const jsonText = answer
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();

    const analysis = JSON.parse(jsonText);

    if (!["BUY", "SELL", "WAIT"].includes(analysis.signal)) {
      throw new Error("AI returned an invalid signal.");
    }

    const confidence = Number(analysis.confidence);

    if (
      !Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 100
    ) {
      throw new Error("AI returned invalid confidence.");
    }

    const validTrends = ["Bullish", "Bearish", "Neutral"];
    const validRSIStatuses = [
      "Oversold",
      "Overbought",
      "Neutral"
    ];

    const trend = validTrends.includes(analysis.trend)
      ? analysis.trend
      : "Neutral";

    const rsiStatus = validRSIStatuses.includes(analysis.rsiStatus)
      ? analysis.rsiStatus
      : "Neutral";

    // Strict filter: the AI's score must reach 80 AND
    // the EMA and MACD directions must agree.
    // This is a filter, not proof of an 80% win rate.
    let finalSignal = analysis.signal;
    let finalReason = String(
      analysis.reason || "Analysis completed."
    );

    const bullishConfirmation =
      emaTrend === "Bullish" &&
      macdTrend === "Positive";

    const bearishConfirmation =
      emaTrend === "Bearish" &&
      macdTrend === "Negative";

    const indicatorsAgree =
      (analysis.signal === "BUY" && bullishConfirmation) ||
      (analysis.signal === "SELL" && bearishConfirmation);

    if (
      analysis.signal === "WAIT" ||
      confidence < MIN_CONFIDENCE ||
      !indicatorsAgree
    ) {
      finalSignal = "WAIT";

      if (confidence < MIN_CONFIDENCE) {
        finalReason =
          `WAIT: analytical score is below ${MIN_CONFIDENCE}. ` +
          finalReason;
      } else if (!indicatorsAgree) {
        finalReason =
          "WAIT: EMA and MACD do not confirm the AI direction. " +
          finalReason;
      }
    }

    res.json({
      symbol,
      price: last,
      rsi: Number(rsi.toFixed(2)),
      emaTrend,
      macdTrend,
      trend,
      rsiStatus,
      signal: finalSignal,
      confidence: Math.round(confidence),
      reason: finalReason,
      candleTime: candles[candles.length - 1].time,
      analyzedAt: new Date().toISOString()
    });

  } catch (error) {
    console.error("Analysis error:", error.message);

    res.status(502).json({
      error:
        "Analysis failed. Check Render logs, Claude API access, model availability and Twelve Data quota."
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `AI Trading Agent server running on port ${PORT}`
  );
});
