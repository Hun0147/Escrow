'use client';

import { useState } from 'react';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export default function Home() {
  const [token, setToken] = useState('');
  const [game, setGame] = useState('EA Sports FC 26');
  const [stake, setStake] = useState(50);
  const [result, setResult] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);

  async function createMatch() {
    setError(null);
    setResult(null);
    const res = await fetch(`${API_URL}/matches`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ game, stakeCents: Math.round(stake * 100) }),
    });
    const data = await res.json();
    if (!res.ok) setError(JSON.stringify(data.error));
    else setResult(data);
  }

  const pool = stake * 2;
  const fee = Math.round(pool * 0.12 * 100) / 100;
  const payout = pool - fee;

  return (
    <main style={{ maxWidth: 480, margin: '60px auto', padding: 24 }}>
      <h1>Create a PS5 Wager</h1>
      <p style={{ color: '#9aa0a6' }}>
        Platform escrow fee: 12% of the prize pool, deducted from the winner's payout at settlement.
      </p>

      <label>Auth Token (from /auth/register or /auth/login)</label>
      <input value={token} onChange={(e) => setToken(e.target.value)} style={inputStyle} placeholder="eyJ..." />

      <label>Game</label>
      <input value={game} onChange={(e) => setGame(e.target.value)} style={inputStyle} />

      <label>Stake (USD)</label>
      <input
        type="number"
        min={1}
        value={stake}
        onChange={(e) => setStake(Number(e.target.value))}
        style={inputStyle}
      />

      <div style={{ margin: '16px 0', padding: 12, background: '#1a1d21', borderRadius: 8 }}>
        <div>Prize pool: ${pool.toFixed(2)}</div>
        <div>Platform fee (12%): ${fee.toFixed(2)}</div>
        <div>Winner payout: ${payout.toFixed(2)}</div>
      </div>

      <button onClick={createMatch} style={buttonStyle}>Create Match</button>

      {error && <pre style={{ color: '#ff6b6b' }}>{error}</pre>}
      {result !== null && result !== undefined ? <pre>{JSON.stringify(result, null, 2)}</pre> : null}
    </main>
  );
}

const inputStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  padding: 8,
  margin: '4px 0 12px',
  background: '#1a1d21',
  border: '1px solid #333',
  borderRadius: 6,
  color: '#f0f0f0',
};

const buttonStyle: React.CSSProperties = {
  padding: '10px 20px',
  background: '#4f8cff',
  border: 'none',
  borderRadius: 6,
  color: 'white',
  cursor: 'pointer',
};
