/** Short synthesized chime for a Juicy (god-tier) find — the OS notification
 *  (notify.ts) is easy to miss with notifications muted/DND, which is common
 *  while gaming; this plays through the game's own audio output instead, no
 *  OS permission needed. Web Audio only, no bundled audio asset — two sine
 *  tones with a short linear envelope so it doesn't click on start/stop. */

let ctx: AudioContext | null = null;

function tone(context: AudioContext, freq: number, startAt: number, duration: number): void {
  const osc = context.createOscillator();
  const gain = context.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0, startAt);
  gain.gain.linearRampToValueAtTime(0.2, startAt + 0.02);
  gain.gain.linearRampToValueAtTime(0, startAt + duration);
  osc.connect(gain).connect(context.destination);
  osc.start(startAt);
  osc.stop(startAt + duration);
}

/** Best-effort — audio failing (autoplay policy, no output device, ...)
 *  should never block or interrupt the analysis flow it's a side effect of. */
export function playJuicyChime(): void {
  try {
    ctx ??= new AudioContext();
    const now = ctx.currentTime;
    tone(ctx, 880, now, 0.15); // A5
    tone(ctx, 1318.5, now + 0.12, 0.2); // E6
  } catch {
    // See file-level comment.
  }
}
