# Roadmap

Ce qu'on prévoit pour les prochaines mises à jour. Le miroir de
[CHANGELOG.md](CHANGELOG.md) (le passé livré) — ici, le futur.

**Usage** : les idées entrent en bas (« Idées »), remontent d'une section
quand on décide de les faire, et sortent du fichier quand c'est livré — la
ligne devient alors une puce du CHANGELOG, réécrite pour les joueurs. Une
ligne = un item, avec référence vers [KNOWN_ISSUES.md](KNOWN_ISSUES.md)
quand elle existe.

## Priorités

1. ✅ **Tests E2E du chemin presse-papier → score** — livré 2026-07-25
   (`src/analyzer/adapter.e2e.test.ts`, 14 tests, vérifiés par mutation).
2. ✅ **Bug écran noir** (KNOWN_ISSUES #1) — instrumenté 2026-07-25 : une
   vraie capture d'écran OS détecte maintenant un rendu noir automatiquement
   après chaque démarrage. **Toujours ouvert** — c'est un diagnostic, pas un
   correctif ; aucune action corrective n'y est câblée pour l'instant.
3. ✅ **Comparaison de waystones** — tranché 2026-07-25 : pas de rebuild du
   mode Compare (retiré en 0.3.8, KNOWN_ISSUES #8). Remplacé par un flash
   automatique et sans geste sur le halo du score quand l'analyse bat le
   meilleur score de la session — livré (`flashSessionBest`, RelicPanel.ts).

Ensuite, par ordre décroissant : canal beta, journalisation structurée,
tests de non-régression visuelle, historique enrichi, multi-écrans,
profils de configuration.

## Ensuite

Validé, mais pas urgent :

- [ ] Test multi-écrans réel — la cascade de fallback (Full → Mini) n'a
      jamais été exercée sur du vrai matériel multi-moniteur/DPI mixte
      (KNOWN_ISSUES #6). Le cas **écran déconnecté** (l'ancrage haut-droite
      visait un écran qui n'existe plus) est corrigé côté code — livré
      2026-07-26, `resolveMonitor()` dans `placement.ts` — mais reste à
      vérifier sur du vrai matériel :
      1. Deux écrans, DPI différent (ex: 100% / 150%) — glisser l'overlay
         de l'un à l'autre, vérifier l'ancrage haut-droite et le fallback
         Mini si l'écran cible est petit.
      2. Débrancher l'écran sur lequel l'overlay est actuellement affiché
         pendant que le jeu tourne — l'overlay doit se ré-ancrer sur un
         écran restant, pas rester bloqué hors-champ.
      3. Changer la résolution d'affichage à la volée (Windows → Réglages
         d'affichage) pendant que l'overlay est visible.
      Si un de ces cas se comporte mal, `Settings → App → Export Logs`
      contient maintenant un événement `monitor-fallback` à chaque fois que
      la résolution de moniteur a dû se rabattre sur primary/available.

## Idées

Vrac à trier.

### Tests & fiabilité

- [ ] **Tests E2E** du chemin complet : coller un vrai texte de waystone,
      vérifier le parsing et le score exact. `verify-adapter.mjs` couvre
      déjà les formules, mais rien ne teste la chaîne presse-papier →
      affichage. Playwright plutôt que des passes manuelles.
- [ ] **Tests de non-régression visuelle** : rendre l'overlay avec des
      fixtures et comparer le HTML/les captures à une référence, pour
      attraper les décalages de mise en page (badge, alignement des
      colonnes) que les tests de formules ne voient pas.
- [ ] Bug écran noir (KNOWN_ISSUES #1) — la capture OS réelle existe
      maintenant (`capture_window_is_blank`, 2026-07-25) et journalise un
      vrai verdict après chaque démarrage, mais **rien ne réagit encore à
      ce verdict**. Pistes encore non tentées :
      - câbler une action corrective quand le verdict est « noir » (nouveau
        nudge, cycle hide/show) — avec précaution : une escalade non testée
        a déjà aggravé les choses une fois (essai #12) ;
      - lancer plusieurs sessions réelles pour voir si le check attrape
        enfin une occurrence noire (pas encore le cas au 2026-07-25) ;
      - exposer un réglage de backend graphique
        (`--angle-graphics-backend=d3d11` au lieu du d3d12 par défaut)
        pour que l'utilisateur teste selon son pilote.
- [x] **Canal beta opt-in** — livré 2026-07-26. A révélé un vrai bug latent :
      il n'existait qu'un seul flux rolling (`updater`), rafraîchi sur
      **chaque** tag — un tag beta aurait donc mis à jour tous les
      utilisateurs stables. Corrigé en même temps : deux flux
      (`updater-beta` sur chaque tag, `updater` seulement sur un tag sans
      suffixe, release.yml), endpoint choisi à l'exécution côté Rust
      (`check_update_channel`) et non plus figé dans tauri.conf.json, plus
      l'interrupteur « Beta channel » dans les Réglages.
- [x] Vérifié 2026-07-26 : `scripts/verify-adapter.mjs` inline déjà son
      SAMPLE (commentaire explicite dans le fichier), aucune dépendance à un
      checkout sibling v2 ni côté script ni côté CI. Rien à corriger.

### Fonctionnalités joueur

- [ ] **Historique enrichi** : au lieu d'une liste plate, une mini-timeline
      de la session avec les meilleures trouvailles colorées, et une
      sparkline du score moyen par heure pour voir si la session se
      dégrade. (L'export CSV par session existe déjà depuis 0.3.9.)
- [ ] **Profils de configuration** : sauvegarder plusieurs jeux de réglages
      (« Delirium », « safe maps », « SSF ») et basculer de l'un à l'autre
      depuis les Réglages. Utile quand on change de stratégie en cours de
      ligue.
- [ ] **Export/import des réglages et de l'historique** dans un fichier,
      pour reprendre sa configuration sur une autre machine ou après une
      réinstallation.
- [x] **Partage de waystone** — livré 2026-07-26 : le code encode l'item
      text brut (gzip + base64url, `share.ts`), pas un résumé séparé du
      score — décoder relance juste `analyzeWaystoneText` normalement, donc
      ça ne peut jamais diverger de `scoring.ts`. Zéro serveur. Bouton
      partage dans le header, import via Réglages → Session (lit le
      presse-papier, ne compte pas dans les stats de session du joueur qui
      importe).
- [x] **Tablettes favorites** — livré 2026-07-26 : « Pin to top » dans le
      popup d'une tablette la remonte en tête de la liste quel que soit son
      fit, avec une ★ sur la ligne. Épinglage par nom (survit à un ajout/
      retrait de tablette via meta.json) et ordre relatif préservé dans
      chaque groupe.
- [x] **Lien vers poe2.re** — livré 2026-07-26 : bouton "Search on poe2.re ↗"
      dans le popup mécanique/tablette (`openTabletPopup`, RelicPanel.ts),
      ouvre `https://poe2.re/tablet` via `tauri-plugin-opener`. Lien simple
      uniquement (pas de deep-link possible, state React local côté
      poe2.re) — voir la note CHANGELOG "Unreleased".
- [x] **Retour utilisateur passif** — livré 2026-07-26 : détection par
      proxy (aucune télémétrie côté jeu n'est possible) — un waystone
      high-score + « Very Dangerous » suivi d'une analyse d'un AUTRE
      waystone dans les 45s déclenche un prompt Oui/Non discret et
      auto-dismiss (10s). Stocké localement dans le log de session
      (`AnalysisLogEntry.skippedForDanger`), affiché dans Réglages →
      Session — pas d'ajustement automatique des seuils pour l'instant.

### Accessibilité

- [ ] **Audit de contraste** de la palette or/rouge sur fond sombre
      (WCAG AA), et une palette de repli à fort contraste pour les
      daltonismes et la sensibilité à la lumière. C'est le point le plus
      concret de ce thème : l'app est dense et repose beaucoup sur la
      couleur pour distinguer les tiers.
- [x] **Navigation au clavier** — livré 2026-07-26. Vérifié : les 10
      contrôles des Réglages sont atteignables au Tab et un panneau fermé ne
      piège pas le focus. Ajouté : contour de focus sur `.set-btn`,
      `.tmp-close` et le lien poe2.re (aucun n'en avait), et surtout la
      traversée du dropdown custom (flèches/Home/End, focus qui entre dans la
      liste à l'ouverture et revient au bouton après choix ou Escape) — il
      s'ouvrait au clavier mais ne se parcourait pas.
- [ ] Compléter les libellés pour lecteurs d'écran — il y en a déjà 12
      dans `RelicPanel.ts`, mais la couverture n'a jamais été auditée.

### Données & scoring

- [ ] Compléter le maître de l'Atlas recommandé pour Irradiated/Temple/
      General — aucune source Fubgun trouvée pour ces 3 cas, l'app
      n'affiche donc rien plutôt que de deviner (choix explicite de
      l'utilisateur). À revoir si une source apparaît. `Abyss` a aussi une
      2e stratégie sourcée (Hilda, orientée rare-monster) non utilisée —
      Jado reste la recommandation affichée, voir
      `src/analyzer/atlas-masters.ts`.
      - Variante : afficher un « ? » cliquable au lieu du silence, disant
        que ce n'est pas encore sourcé — transparent sans rien inventer.
- [ ] **Fraîcheur des données de tablettes** : ajouter un `last_synced_at`
      et un rafraîchissement en tâche de fond depuis
      `repoe-fork.github.io/poe2/mods.json` (la source data-minée qui a
      déjà servi le 2026-07-12), en journalisant les écarts. À faire
      **côté Rust avec `reqwest`**, au démarrage, jamais dans `analyze()` :
      KNOWN_ISSUES #2 a déjà rejeté la version inline pour CORS et pour le
      budget « Ins → réaction < 100 ms ».
- [x] **Étendre le schéma de confiance des tablettes aux mécaniques** —
      livré 2026-07-26 : `MechanicDef` (mechanics.ts) a maintenant le même
      `confidence`/`source` optionnel que `RawTabletDef` (tablets.ts),
      informationnel uniquement (pas de logique de scoring qui en dépend).
      Chaque entrée reflète sa sourcing existante en commentaire : Abyss/
      Breach en `high` (deux sources communautaires indépendantes qui
      convergent), Delirium/Expedition/Ritual en `medium` (consensus
      communautaire simple), General/Irradiated/Temple en `low`/`manual`
      (aucune source citée). meta.json ne peut pas overrider ces champs
      (`applyOverride` ne les touche pas), même convention que
      tablets.ts — pas d'écran "Data Quality" pour l'instant, juste la
      donnée disponible pour un futur affichage.
- [ ] **Télémétrie anonyme opt-in** : distribution des scores, tablettes
      retenues, mécaniques gagnantes. Le seul moyen de valider que le
      modèle de score colle au jeu réel plutôt qu'à des guides
      contradictoires — la fatigue de re-sourcer est documentée dans
      KNOWN_ISSUES #3. Nécessite un serveur : décider si ça vaut le coût.
- [ ] **Heatmap mécaniques × stats** alimentée par l'historique, pour voir
      quelles combinaisons rollent bien dans sa propre session.
- [ ] **Estimation de profit** via une API de prix — dépendance externe et
      marché volatil, à ne considérer que si tout le reste est fait.

### Confort & diagnostic

- [x] **Journalisation structurée** — livré 2026-07-26 : `tracing` +
      `tracing-appender` (fichier journal quotidien dans `app_log_dir()`,
      writer non-bloquant — rien sur le chemin chaud), tous les `println!`
      de `lib.rs` migrés avec `target`/champs structurés. Export depuis les
      Réglages → App → **Export Logs** (`revealItemInDir`, capability
      `opener:allow-reveal-item-in-dir`). Prépare le diagnostic à distance du
      bug écran noir (KNOWN_ISSUES.md §1) — reste à récupérer un vrai log
      d'un testeur ayant reproduit le bug.
- [x] **Surveillance de `meta.json`** — livré 2026-07-26 : `watchMetaFile`
      (plugin-fs, feature `watch`, debounce 1s) recharge les tables quand le
      fichier change hors de l'app, rafraîchit l'éditeur ouvert et journalise
      le rechargement. Vérifié par une vraie édition externe du fichier.
      Le résultat affiché n'est pas re-scoré — la prochaine analyse prend le
      changement, exactement comme après une édition in-app.
- [ ] **Temps de démarrage** : profiler et vérifier si les données de
      tablettes sont reparsées à chaque `analyze()` ; si oui, mettre en
      cache après le premier parse.
- [x] **Mode debug** (`OVERLAY_DEBUG=1`) — livré 2026-07-26 : coin bas-gauche
      affichant « N mods · score · durée » (parse + rendu), lu depuis Rust
      (`is_debug_overlay`) puisque la variable d'env est invisible au
      webview. Masqué et sans coût en build normal. Documenté dans le README.
- [x] **Bouton « Valider meta.json »** — livré 2026-07-26 : re-lit le fichier
      sur disque et rapporte l'erreur JSON exacte avec ligne/colonne
      (`validateMetaFile`, meta-schema.ts), au lieu du fallback silencieux
      qu'utilise `loadMetaConfig` partout ailleurs.
- [x] **Micro-infobulles** — livré 2026-07-26 : le hover de chaque stat du
      Heat Breakdown reprend la phrase du Guide expliquant ce qu'elle mesure
      (`BREAKDOWN_TOOLTIPS`, RelicPanel.ts), une seule voix entre le Guide et
      le panneau au lieu de deux textes qui pourraient diverger.

### Écartés pour l'instant

- **i18n multilingue** — l'app est passée 100% anglais en 0.2.6, c'est une
  décision assumée, et le français restant dans les docs internes
  (CHANGELOG, cette roadmap) est délibéré : ces fichiers s'adressent au
  mainteneur. À rouvrir seulement si des joueurs non anglophones le
  demandent. (Note : `react-i18next` ne s'applique pas — le projet est en
  TypeScript vanilla, sans React.)
- **Pré-analyse du presse-papier en tâche de fond** — le budget actuel est
  déjà « Ins → réaction < 100 ms », et un polling permanent ajoute une
  boucle qui tourne en jeu pour gagner quelques dizaines de millisecondes.
- **Code-splitting du bundle** — l'app tient en un seul écran, le gain
  serait invisible.
- **Vidéo d'accueil** — coût de production élevé pour un outil dont le
  mode d'emploi tient en une phrase (survoler, appuyer sur Ins).

## Sources de données

Déjà utilisées, par ordre de fiabilité — voir KNOWN_ISSUES #2/#3 pour
l'historique complet de sourcing :

- **poe2db.tw** et **repoe-fork** (`repoe-fork.github.io/poe2/mods.json`) —
  data-minées directement des fichiers du jeu, la seule catégorie
  vraiment garantissable (mods/ranges exacts).
- **maxroll.gg**, **Fubgun** (strats Mobalytics), **poe2wiki.net**,
  **odealo.com** — guides communautaires, croisés 2-3 sources avant usage,
  jamais pris seuls (c'est cette discipline de recoupement, pas la
  quantité de sources, qui a résolu la plupart des items de KNOWN_ISSUES #2).

Pistes non explorées, notées pour mémoire mais pas actionnables en l'état
(brainstorm, pas de plan concret) : Discord/Reddit communautaires, VODs de
streamers, un forum GitHub Discussions pour crowdsourcer des retours
utilisateur. Aucune n'a de format exploitable identifié — à ne reprendre
que si l'une d'elles se précise en une vraie source citable.

## Notes d'implémentation

- Tout appel réseau passe côté Rust (`reqwest`), jamais dans le chemin
  d'analyse.
- E2E avec Playwright, pas de passes manuelles instables — en sachant que
  les captures CDP ne voient pas le bug de rendu (KNOWN_ISSUES #1).
- Chaque nouvelle option de configuration passe par
  `src/overlaySettings.ts`, pas en dur dans le composant.
- Garder le format de `meta.json` simple : il fonctionne.
