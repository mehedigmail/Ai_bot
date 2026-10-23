require("dotenv").config();

const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY;

const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-20b";

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    message: "AI Trading Agent backend is running",
    twelveDataConfigured: Boolean(TWELVE_DATA_API_KEY),
    groqConfigured: Boolean(GROQ_API_KEY),
    model: GROQ_MODEL
  });
});

app.get("/api/analyze", async (req, res) => {
  try {
    if (!TWELVE_DATA_API_KEY || !GROQ_API_KEY) {
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
      return res.status(400).json({
        error: "Unsupported currency pair."
      });
    }

    // Fetch one-minute market candles from Twelve Data.
    const url = new URL(
      "https://api.twelvedata.com/time_series"
    );

    url.searchParams.set("symbol", symbol);
    url.searchParams.set("interval", "1min");
    url.searchParams.set("outputsize", "100");
    url.searchParams.set("apikey", TWELVE_DATA_API_KEY);

    const marketResponse = await fetch(url);
    const marketData = await marketResponse.json();

    if (!marketResponse.ok || marketData.status === "error") {
      console.error("Twelve Data error:", marketData.message);

      return res.status(502).json({
        error: marketData.message ||
          "Market data request failed. Check Twelve Data API access and quota."
      });
    }

    if (
      !Array.isArray(marketData.values) ||
      marketData.values.length < 30
    ) {
      return res.status(502).json({
        error: "Insufficient market candles received."
      });
    }

    // Twelve Data returns candles newest first.
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
        !Number.isFinite(c.close)
      )
    ) {
      throw new Error("Market data contains invalid prices.");
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

        if (change > 0) gains += change;
        else losses -= change;
      }

      let avgGain = gains / period;
      let avgLoss = losses / period;

      for (let i = period + 1; i < values.length; i++) {
        const change = values[i] - values[i - 1];
        const gain = Math.max(change, 0);
        const loss = Math.max(-change, 0);

        avgGain =
          (avgGain * (period - 1) + gain) / period;

        avgLoss =
          (avgLoss * (period - 1) + loss) / period;
      }

      if (avgLoss === 0) return 100;

      return 100 - 100 / (1 + avgGain / avgLoss);
    }

    const last = closes[closes.length - 1];
    const previous = closes[closes.length - 2];
    const rsi = calculateRSI(closes, 14);

    const ema9 = ema(closes.slice(-40), 9);
    const ema21 = ema(closes.slice(-60), 21);

    const emaTrend =
      ema9 > ema21 ? "Bullish" :
      ema9 < ema21 ? "Bearish" : "Neutral";

    const macdLine =
      ema(closes.slice(-35), 12) -
      ema(closes.slice(-35), 26);

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

    const prompt = `
You are a cautious financial market analysis assistant.

Analyze the supplied one-minute market candle data.
Never guarantee profit or claim certainty.
Do not invent data or predict future prices as facts.

Return ONLY valid JSON in this exact structure:
{
  "signal": "BUY",
  "confidence": 50,
  "trend": "Neutral",
  "rsiStatus": "Neutral",
  "reason": "Brief explanation"
}

Rules:
- signal must be BUY, SELL, or WAIT.
- confidence must be an integer from 0 to 100.
- trend must be Bullish, Bearish, or Neutral.
- rsiStatus must be Oversold, Overbought, or Neutral.
- Use WAIT if evidence is weak or conflicting.
- Confidence is analytical confidence, not probability of winning.
- Do not include Markdown or code fences.

Market data:
${JSON.stringify(marketSummary)}
`;

    // Request analysis from Groq.
    const groqResponse = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${GROQ_API_KEY}`
        },
        body: JSON.stringify({
          model: GROQ_MODEL,
          messages: [
            {
              role: "system",
              content:
                "You analyze market data cautiously and return valid JSON only."
            },
            {
              role: "user",
              content: prompt
            }
          ],
          temperature: 0.2,
          max_completion_tokens: 500
        })
      }
    );

    const groqData = await groqResponse.json();

    if (!groqResponse.ok) {
      console.error(
        "Groq API error:",
        JSON.stringify(groqData)
      );

      return res.status(502).json({
        error:
          groqData.error?.message ||
          "Groq API request failed. Check API access, model availability and quotas."
      });
    }

    const answer =
      groqData.choices?.[0]?.message?.content;

    if (!answer) {
      throw new Error("Groq returned an empty response.");
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

    res.json({
      symbol,
      price: last,
      rsi: Number(rsi.toFixed(2)),
      emaTrend,
      macdTrend:
        macdLine > 0 ? "Positive" :
        macdLine < 0 ? "Negative" : "Neutral",
      trend: validTrends.includes(analysis.trend)
        ? analysis.trend
        : "Neutral",
      rsiStatus: validRSIStatuses.includes(analysis.rsiStatus)
        ? analysis.rsiStatus
        : "Neutral",
      signal: analysis.signal,
      confidence: Math.round(confidence),
      reason: String(
        analysis.reason || "Analysis completed."
      ),
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
  console.log(
    `AI Trading Agent server running on port ${PORT}`
  );
});
