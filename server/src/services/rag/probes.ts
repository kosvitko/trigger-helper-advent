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
  // CH-3 (корпус v2, дизайн D-7, 05.10): расширение 12 → 32 on-corpus для честного
  // бейзлайна hit@1 (шаг 0.083 на пробу был слишком груб для гейта «до/после»);
  // ожидания проверены grep-покрытием по data/points (правило day-21: шумные
  // пробы губят метрику). Бытовые формулировки помечены «(бытовая)».
  { q: "отёк и мурашки в кисти без травмы — какая мышца", expectSources: ["data/points/pectoralis-minor.md"] },
  { q: "звон в ухе с одной стороны — может ли это быть мышца", expectSources: ["data/points/pterygoideus-lateralis.md", "data/points/sternocleidomastoideus.md"] },
  { q: "щёлкает в челюсти при открывании рта (бытовая)", expectSources: ["data/points/pterygoideus-lateralis.md", "data/points/sternocleidomastoideus.md"] },
  { q: "обмороки при повороте головы — о чём это", expectSources: ["data/points/sternocleidomastoideus.md"] },
  { q: "болит нёбо, как при простуде, но простуды нет", expectSources: ["data/points/pterygoideus-medialis.md"] },
  { q: "картинка иногда расплывается — при чём тут мышцы", expectSources: ["data/points/pterygoideus-medialis.md"] },
  { q: "ком в горле, трудно глотать (бытовая)", expectSources: ["data/points/digastricus-mm-mylohyoideus-stylohyoideus-mm-longus-capitis-et-longus-colli.md"] },
  { q: "осиплость голоса к вечеру — какая мышца", expectSources: ["data/points/digastricus-mm-mylohyoideus-stylohyoideus-mm-longus-capitis-et-longus-colli.md"] },
  { q: "ноют верхние зубы, стоматолог не находит причин", expectSources: ["data/points/temporalis.md"] },
  { q: "болят дёсны, хотя с зубами всё в порядке", expectSources: ["data/points/buccinator.md", "data/points/masseter.md"] },
  { q: "жжение между лопатками — какая мышца", expectSources: ["data/points/infraspinatus.md", "data/points/mm-scaleni-anterior-medius-posterior-minimus.md"] },
  { q: "скованность в шее, голова тяжёлая (бытовая)", expectSources: ["data/points/mm-suboccipitales.md"] },
  { q: "не хватает сил застегнуть молнию куртки — ноет запястье (бытовая)", expectSources: ["data/points/flexor-carpi-radialis-m-flexor-carpi-ulnaris-m-flexor-digitorum-superficialis-m-flexor-digitorum-profundus-m-flexor-pollicis-longus.md"] },
  { q: "тяжело нести сумку, ноет плечо (бытовая)", expectSources: ["data/points/deltoideus.md", "data/points/supraspinatus.md", "data/points/teres-minor.md", "data/points/musculus-brachialis.md"] },
  { q: "болит висок с одной стороны, думал, зуб (бытовая)", expectSources: ["data/points/masseter.md", "data/points/temporalis.md"] },
  { q: "не завести руку за спину — тянет в плече (бытовая)", expectSources: ["data/points/musculus-coracobrachialis.md", "data/points/pectoralis-minor.md"] },
  { q: "жжёт ладонь и запястье изнутри — какая мышца", expectSources: ["data/points/flexor-carpi-radialis-m-flexor-carpi-ulnaris-m-flexor-digitorum-superficialis-m-flexor-digitorum-profundus-m-flexor-pollicis-longus.md", "data/points/musculus-palmaris-longus.md"] },
  { q: "трудно писать карандашом и щипать — болит большой палец (бытовая)", expectSources: ["data/points/adductor-pollicis-m-opponens-pollicis.md"] },
  { q: "ноет лоб, когда морщусь и хмурюсь (бытовая)", expectSources: ["data/points/occipitofrontalis.md"] },
  { q: "лицо болит при гримасах и широкой улыбке (бытовая)", expectSources: ["data/points/mm-cutanei-m-orbicularis-oculi-m-zygomaticus-major-m-platysma.md", "data/points/platysma.md"] },
  // Day24 (design D-4, Δ-3): off-corpus — порог «не знаю» обязан пройти
  // через near-miss дистракторы (массаж/растяжка спины — про тело, но не
  // триггерные точки) + дальний домен; expectSources пуст по определению.
  { q: "как делать массаж спины", expectSources: [], kind: "offCorpus" },
  { q: "растяжка для спины", expectSources: [], kind: "offCorpus" },
  { q: "какая завтра будет погода в Москве", expectSources: [], kind: "offCorpus" },
  { q: "как настроить VPN на компьютере", expectSources: [], kind: "offCorpus" },
  { q: "рецепт борща на 4 порции", expectSources: [], kind: "offCorpus" },
];
