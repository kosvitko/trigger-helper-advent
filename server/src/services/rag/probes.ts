/**
 * Day23 (design D-7, pass 05 F-05-2): the single source of the card-corpus
 * retrieval probes. Both scripts import from here — importing from
 * build-rag-index.ts itself is FORBIDDEN: its top-level main() would run a
 * full index rebuild as an import side effect.
 *
 * Day22 probes (design D-13, addendum): points corpus — symptom → expected
 * point card. Ground truth verified for uniqueness by grep over data/points/
 * (day-21 lesson: noisy probes wreck the metric); multi-label groups keep the
 * day-21 rule — rank = best position among the group. The day-21 docs corpus
 * and its 17 probes live on in tag week05-day21.
 */

export interface Probe {
  q: string;
  /** Canonical answer file(s). Cust-fix 29.09 (решение Кости): multi-label —
   *  proposals+design pairs describe the same work, rank = best position
   *  among the group; single unique docs keep one entry. */
  expectSources: string[];
  /** Day24 (design D-4, Δ-3): off-corpus probes tune the dontKnow gate —
   *  no expectSources, excluded from the rerank sweep and retrieval compare
   *  (tune-rerank/build-rag-index skip them). On-corpus probes carry no
   *  flag (undefined = onCorpus). */
  kind?: "offCorpus";
}

export const PROBES: Probe[] = [
  // Unique: the symptom lives in exactly one card.
  { q: "сухой приступообразный кашель — может ли это быть от триггерной точки", expectSources: ["data/points/sternocleidomastoideus.md"] },
  { q: "слезотечение и птоз на одном глазу — какая мышца виновата", expectSources: ["data/points/sternocleidomastoideus.md"] },
  { q: "точки от жвачки и ночного скрежета зубами — о какой мышце речь", expectSources: ["data/points/masseter.md"] },
  { q: "боль в глубине уха и заложенность уха — какая мышца", expectSources: ["data/points/masseter.md"] },
  { q: "хруст или треск в мышцах при движении плеча", expectSources: ["data/points/rhomboideus-major-et-minor.md"] },
  { q: "зубы реагируют на перепады температуры, но стоматолог ничего не нашёл", expectSources: ["data/points/temporalis.md"] },
  { q: "аритмия от триггерной точки между рёбрами — какая мышца", expectSources: ["data/points/pectoralis-major-et-subclavius.md"] },
  { q: "мурашки по верху предплечья — от какой мышцы", expectSources: ["data/points/trapezius.md"] },
  { q: "онемение большого пальца без потери чувствительности", expectSources: ["data/points/mm-scaleni-anterior-medius-posterior-minimus.md"] },
  // Multi-label: the symptom honestly lives in several cards.
  { q: "головокружение и шаткость при повороте головы", expectSources: ["data/points/masseter.md", "data/points/sternocleidomastoideus.md"] },
  { q: "«синусит», который не поддаётся лечению", expectSources: ["data/points/masseter.md", "data/points/pterygoideus-lateralis.md"] },
  { q: "боль в височно-нижнечелюстном суставе при жевании", expectSources: ["data/points/masseter.md", "data/points/pterygoideus-lateralis.md", "data/points/pterygoideus-medialis.md", "data/points/sternocleidomastoideus.md"] },
  // Day24 (design D-4, Δ-3): off-corpus — порог «не знаю» обязан пройти
  // через near-miss дистракторы (массаж/растяжка спины — про тело, но не
  // триггерные точки) + дальний домен; expectSources пуст по определению.
  { q: "как делать массаж спины", expectSources: [], kind: "offCorpus" },
  { q: "растяжка для спины", expectSources: [], kind: "offCorpus" },
  { q: "какая завтра будет погода в Москве", expectSources: [], kind: "offCorpus" },
  { q: "как настроить VPN на компьютере", expectSources: [], kind: "offCorpus" },
  { q: "рецепт борща на 4 порции", expectSources: [], kind: "offCorpus" },
];
