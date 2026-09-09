# Tabless generation — validated 2026-09-09

Controlled experiment: does a ChatGPT MCP-tool-looping turn continue when its tab is
destroyed? **Yes — strongest form confirmed.** Subject conversation
`6aa1987f-1e04-83e8-8a6d-62f8f31a9969` (scratch, excluded from fleet accounting):
~10 connector calls verified flowing, then `Target.closeTarget` at 17:37:22 (tab
verified gone from `/json`), after which the turn ran **11 more minutes with no
client**, made ~91 further calls (rate *increased* from ~4.1 to ~8.3/min — the live
client throttles the server loop), and completed its final message. 79% of the turn
executed clientless. Remount at 18:00 rendered the finished turn fully (~20s mount).

Design facts this establishes for a sleep/wake tab architecture:

1. **Generation and the tool loop live entirely at OpenAI.** The tab is needed only
   at turn boundaries: detect end, record the finished turn, push the next message.
2. **Page evidence during sleep is actively false, not just absent** — the extension
   logged `turn_end unknown` 6 seconds after closure while the server ran 11 more
   minutes. (The `observer_lost` recorder work already labels this class honestly.)
   A closed generating tab can also make *another* chat look temporally unique;
   fleet-wide sleep makes page-evidence temporal binding non-viable.
3. **Wake detector:** per-conversation call-stream quiescence with a ≥3–5 minute
   threshold (legitimate mid-turn gaps reached ~80s), then remount to confirm the
   rendered final message. The final text-writing phase is call-silent — quiescence
   alone is not completion; quiescence + remount-confirm is.
4. **Push-correlated binding replaces temporal inference:** the daemon knows which
   conversation it just pushed, pushes are serialized, and the session key that
   begins calling seconds later is that conversation's — a stronger attribution
   signal than temporal uniqueness, native to the sleep/wake model.
5. **Open risk (n=1, under test):** a different scratch conversation had its
   connector disabled on turns 2–3 ("tool has been disabled", calls silently served
   by the built-in container — transcript claims reads the daemon never saw). If
   wake-and-continue routinely loses the connector, the architecture becomes
   fresh-conversation-per-work-unit instead of long-lived slept chats. Daemon-side
   verification is the only truth for "connector worked"; transcripts lie under
   fallback.

Payoff if implemented: resident renderer count decouples from fleet width entirely —
tabs exist only at boundaries (typically 1–3 at once), and stream width becomes
bounded by OpenAI concurrency rather than local RAM.
