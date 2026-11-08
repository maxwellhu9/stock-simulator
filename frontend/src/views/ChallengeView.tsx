import { useEffect, useRef, useState } from "react";
import { OrderBook } from "../components/OrderBook";
import { PriceChart } from "../components/PriceChart";
import {
  BOTS, type BotName, type BotStats, type ChallengeEvent, type Outcome, Round, SECONDS, TARGET,
  pickEvent, runTrials,
} from "../demo/challenge";
import { money, signed } from "../format";

const QUICK_TRIALS = 40;
const FULL_TRIALS = 200;
const SIZES = [100, 500, 1000];

type Stage = "ready" | "playing" | "done";

export function ChallengeView() {
  const [stage, setStage] = useState<Stage>("ready");
  const [, redraw] = useState(0);
  const round = useRef<Round | null>(null);
  const event = useRef<ChallengeEvent | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [stats, setStats] = useState<Record<BotName, BotStats> | null>(null);
  const [running, setRunning] = useState<number | null>(null);

  const refresh = () => redraw((n) => n + 1);

  const finish = async () => {
    const e = event.current!;
    setOutcome(round.current!.result());
    setStats(null);
    setStage("done");
    setStats(await runTrials(e, QUICK_TRIALS));
  };

  const start = () => {
    event.current = pickEvent();
    round.current = new Round(event.current);
    setOutcome(null);
    setStats(null);
    setStage("playing");
  };

  useEffect(() => {
    if (stage !== "playing") return;
    const id = setInterval(() => {
      const r = round.current!;
      r.step();
      if (r.over) finish();
      else refresh();
    }, 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage]);

  const act = (fn: (r: Round) => void) => {
    const r = round.current!;
    fn(r);
    if (r.over) finish();
    else refresh();
  };

  const runMore = async () => {
    setRunning(0);
    const s = await runTrials(event.current!, FULL_TRIALS, setRunning);
    setStats(s);
    setRunning(null);
  };

  if (stage === "ready") {
    return (
      <div className="challenge-start card">
        <h1>Buy {TARGET.toLocaleString()} shares in {SECONDS} seconds</h1>
        <p className="note">
          Buy too fast and you push the price up on yourself. Buy too slowly and you run out of
          time. Something will happen partway through.
        </p>
        <button className="btn btn-ink" onClick={start}>Start</button>
      </div>
    );
  }

  const r = round.current!;

  if (stage === "playing") {
    const series = r.series();
    const avg = r.filled ? r.notional / r.filled : null;
    const eventTime = r.eventTime;
    return (
      <div className="grid">
        <div className="card span-8">
          <div className="challenge-top">
            <div>
              <div className="challenge-clock num">{SECONDS - r.second}s</div>
              <div className="muted">left</div>
            </div>
            <div className="challenge-progress">
              <div className="challenge-count num">
                <b>{r.filled.toLocaleString()}</b> / {TARGET.toLocaleString()} bought
              </div>
              <div className="challenge-bar"><i style={{ width: `${(r.filled / TARGET) * 100}%` }} /></div>
              <div className="muted num challenge-sub">
                Start {money(r.arrival)} · Now {money(r.last)}{avg !== null && ` · Your average ${money(avg)}`}
              </div>
            </div>
          </div>

          <div className="challenge-news">
            {eventTime !== null ? <b>{event.current!.headline}</b> : <span className="muted">Nothing yet…</span>}
          </div>

          <div className="chart-wrap">
            <PriceChart series={series} baseline={r.arrival} height={250}
                        markers={eventTime !== null ? [{ t: eventTime, tone: "accent" }] : undefined} />
          </div>

          <div className="challenge-actions">
            {SIZES.map((q) => (
              <button key={q} className="btn btn-buy" disabled={r.need <= 0} onClick={() => act((x) => x.buy(q))}>
                Buy {q.toLocaleString()}
              </button>
            ))}
            <button className="btn btn-quiet" disabled={r.need <= 0} onClick={() => act((x) => x.bid(500))}>
              {r.restingBid > 0 ? `Bid waiting (${r.restingBid})` : "Bid 500 and wait"}
            </button>
          </div>
        </div>

        <div className="card span-4">
          <h2 className="card-title">Sellers and buyers</h2>
          <OrderBook book={r.book()} levels={6} />
        </div>
      </div>
    );
  }

  const you = outcome!;
  const costly = you.extraCost > 0;
  const beaten = stats ? BOTS.filter((b) => you.extraCost < stats[b.key].extraCost).length : null;
  const rows = stats
    ? [...BOTS].sort((a, b) => stats[a.key].extraCost - stats[b.key].extraCost)
    : BOTS;

  return (
    <div className="grid">
      <div className="card span-12">
        <div className="balance-label">{you.filled.toLocaleString()} of {TARGET.toLocaleString()} shares bought</div>
        <div className={`balance num ${costly ? "down" : "up"}`}>{signed(you.extraCost)}</div>
        <p className="note" style={{ marginTop: 0 }}>
          {costly ? "More" : "Less"} than if every share had cost the starting price.
          {beaten !== null && ` You beat ${beaten} of the 3 bots.`}
        </p>
        <p className="muted challenge-sub">The event was: {event.current!.headline}</p>

        <table className="table">
          <thead>
            <tr><th>Trader</th><th>Bought</th><th className="wide">Avg price</th><th>Extra cost</th><th className="wide">Usual range</th></tr>
          </thead>
          <tbody>
            <tr className="challenge-you">
              <td><b>You</b></td>
              <td>{Math.round((you.filled / TARGET) * 100)}%</td>
              <td className="wide">{you.avgPrice ? money(you.avgPrice) : "—"}</td>
              <td>{signed(you.extraCost)}</td>
              <td className="wide muted">one round</td>
            </tr>
            {rows.map((b) => {
              const s = stats?.[b.key];
              return (
                <tr key={b.key}>
                  <td>{b.name}<div className="muted challenge-desc">{b.description}</div></td>
                  <td>{s ? `${Math.round((s.filled / TARGET) * 100)}%` : "…"}</td>
                  <td className="wide">{s && s.avgPrice ? money(s.avgPrice) : "…"}</td>
                  <td>{s ? signed(Math.round(s.extraCost)) : "…"}</td>
                  <td className="wide muted">{s ? `${signed(s.low)} to ${signed(s.high)}` : "…"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <p className="muted challenge-sub">
          Shares not bought in time cost the final price plus 5%. Bot numbers are averages
          of {stats?.even.trials ?? QUICK_TRIALS} simulated rounds with the same event.
        </p>

        <div className="challenge-actions">
          <button className="btn btn-ink" onClick={start}>Play again</button>
          <button className="btn btn-quiet" disabled={running !== null || !stats} onClick={runMore}>
            {running !== null ? `Running… ${running}/${FULL_TRIALS}` : `Run ${FULL_TRIALS} trials`}
          </button>
        </div>
      </div>
    </div>
  );
}
