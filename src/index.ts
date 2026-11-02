/**
 * injection-detector — zero-cost prompt-injection flagging via bge-m3.
 *
 * THE IDEA (proven experimentally 2026-11-02, estate archive
 * 2026-11-02-tau-bge-m3-blackbox/W7-*): the bge-m3 embedding space has a
 * STABLE instruction-vs-data axis. Pure instructions project positive
 * (+0.27..+0.43), pure data negative (-0.30..-0.38) — a clean zero-crossing —
 * and instruction TEXT embedded inside data (injection payloads) projects
 * positive but attenuated. One embed + one dot product = a free, model-agnostic
 * injection tripwire for any text entering an agent's context.
 *
 * Hardcore detail: the axis is computed FROM THE CALLER'S calibration sets
 * (not hardcoded), so it adapts to the deployment's own notion of
 * "instruction-like" text. Unseen mixed payloads still flag.
 */
import { readFileSync } from "node:fs";

export interface CalibrationSets {
  instructions: string[];
  data: string[];
}

export interface InjectorOptions {
  /** Embedding endpoint (OpenAI-compatible /v1/embeddings). */
  baseUrl?: string;
  model?: string;
  /** env var name carrying the key; resolved via secretsmith at runtime. */
  keyEnv?: string;
  /** Optional pre-computed axis (skips calibration embeds). */
  axis?: number[];
  /** Projection above this => FLAGGED. Auto-derived from calibration if omitted. */
  boundary?: number;
}

export interface Verdict {
  projection: number;
  boundary: number;
  flagged: boolean;
  /** 0..1 — how far past the boundary toward instruction-space. */
  severity: number;
}

const dim = 1024;
const cos = (a: number[], b: number[]) => { let d=0,na=0,nb=0; for (let i=0;i<a.length;i++){d+=a[i]*b[i];na+=a[i]*a[i];nb+=b[i]*b[i];} return d/Math.sqrt(na*nb); };
const norm = (a: number[]) => { const n = Math.sqrt(a.reduce((s,x)=>s+x*x,0)); return a.map(x=>x/n); };
const sub = (a: number[], b: number[]) => a.map((x,i)=>x-b[i]);
const mean = (vs: number[][]) => norm(vs.reduce((a,v)=>a.map((x,i)=>x+v[i]/vs.length), new Array(dim).fill(0)));

async function keyringKey(env = "FREEINFERENCE_API_KEY"): Promise<string> {
  const p = Bun.spawnSync(["sh","-c",`secretsmith env | grep '^${env}=' | cut -d= -f2- | tr -d "'"`]);
  const k = new TextDecoder().decode(p.stdout).trim();
  if (!k) throw new Error(`keyring missing ${env}`);
  return k;
}

export class InjectionDetector {
  #axis: number[];
  #boundary: number;
  #embed: (inputs: string[]) => Promise<number[][]>;

  constructor(axis: number[], boundary: number, embed: (inputs: string[]) => Promise<number[][]>) {
    this.#axis = axis;
    this.#boundary = boundary;
    this.#embed = embed;
  }

  static async build(sets: CalibrationSets, opts: InjectorOptions = {}): Promise<InjectionDetector> {
    const baseUrl = opts.baseUrl ?? "https://freeinference.org/v1/embeddings";
    const model = opts.model ?? "bge-m3";
    const key = await keyringKey(opts.keyEnv);
    const embed = async (inputs: string[]) => {
      const res = await fetch(baseUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, input: inputs }),
      });
      if (!res.ok) throw new Error(`embeddings ${res.status}: ${(await res.text()).slice(0, 120)}`);
      return (await res.json()).data.map((x: { embedding: number[] }) => x.embedding);
    };

    let axis: number[];
    let boundary: number;
    if (opts.axis && opts.boundary !== undefined) {
      axis = opts.axis; boundary = opts.boundary;
    } else {
      const V = await embed([...sets.instructions, ...sets.data]);
      const I = V.slice(0, sets.instructions.length);
      const D = V.slice(sets.instructions.length);
      const iMean = mean(I), dMean = mean(D);
      axis = norm(sub(iMean, dMean));
      const pos = I.map(v => axis.reduce((s,x,k)=>s+x*v[k],0));
      const neg = D.map(v => axis.reduce((s,x,k)=>s+x*v[k],0));
      boundary = (Math.min(...pos) + Math.max(...neg)) / 2;
    }
    return new InjectionDetector(axis, boundary, embed);
  }

  async scan(texts: string[]): Promise<Verdict[]> {
    const V = await this.#embed(texts);
    return V.map(v => {
      const projection = this.#axis.reduce((s,x,k)=>s+x*v[k], 0);
      const severity = Math.max(0, Math.min(1, (projection - this.#boundary) / Math.max(1e-6, 1 - this.#boundary)));
      return { projection, boundary: this.#boundary, flagged: projection > this.#boundary, severity };
    });
  }

  async scanOne(text: string): Promise<Verdict> {
    return (await this.scan([text]))[0]!;
  }

  /** Serialize axis+boundary for reuse without re-calibration. */
  export(): { axis: number[]; boundary: number } {
    return { axis: this.#axis, boundary: this.#boundary };
  }

  static fromExported(e: { axis: number[]; boundary: number }, embed: (inputs: string[]) => Promise<number[][]>): InjectionDetector {
    return new InjectionDetector(e.axis, e.boundary, embed);
  }
}