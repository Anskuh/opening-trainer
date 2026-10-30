// Tiny synthesized sounds (no audio files needed).
import { data } from './store.js';

let ctx = null;

function audio() {
  if (!ctx) {
    try {
      ctx = new AudioContext();
    } catch (e) {
      return null;
    }
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function tone(freq, start, dur, type = 'sine', gain = 0.12) {
  const a = audio();
  if (!a) return;
  const osc = a.createOscillator();
  const g = a.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  const t = a.currentTime + start;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(a.destination);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

function click(capture) {
  const a = audio();
  if (!a) return;
  const len = Math.floor(a.sampleRate * 0.05);
  const buf = a.createBuffer(1, len, a.sampleRate);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < len; i++) ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 6);
  const src = a.createBufferSource();
  src.buffer = buf;
  const filter = a.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = capture ? 2400 : 1500;
  const g = a.createGain();
  g.gain.value = capture ? 0.9 : 0.6;
  src.connect(filter).connect(g).connect(a.destination);
  src.start();
}

export const sound = {
  move(san = '') {
    if (data.settings.sound) click(san.includes('x'));
  },
  good() {
    if (!data.settings.sound) return;
    tone(660, 0, 0.12);
    tone(880, 0.08, 0.18);
  },
  bad() {
    if (!data.settings.sound) return;
    tone(196, 0, 0.25, 'triangle', 0.15);
  },
  done() {
    if (!data.settings.sound) return;
    tone(523, 0, 0.14);
    tone(659, 0.1, 0.14);
    tone(784, 0.2, 0.25);
  },
};
