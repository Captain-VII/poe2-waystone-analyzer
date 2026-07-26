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
      (KNOWN_ISSUES #6). Inclure le cas **écran déconnecté** : l'ancrage
      haut-droite vise un écran qui n'existe plus.

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
- [ ] **Canal beta opt-in** dans les Réglages, pour tester avant la
      release publique. L'infrastructure existe déjà (tags `beta`,
      [BETA_NOTES.md](BETA_NOTES.md), flux updater) — ce qui manque, c'est
      le choix du canal côté app.
- [ ] Vérifier que `scripts/verify-adapter.mjs` n'a plus de dépendance à un
      checkout sibling v2 (fragilité CI potentielle relevée le 2026-07-11).

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
- [ ] **Partage de waystone** : encoder l'analyse en chaîne compacte à
      coller dans Discord, décodable par une autre instance. Zéro serveur,
      juste du parsing bidirectionnel.
- [ ] **Tablettes favorites** : en épingler quelques-unes pour qu'elles
      restent visibles en haut de la liste même quand leur fit est faible.
- [x] **Lien vers poe2.re** — livré 2026-07-26 : bouton "Search on poe2.re ↗"
      dans le popup mécanique/tablette (`openTabletPopup`, RelicPanel.ts),
      ouvre `https://poe2.re/tablet` via `tauri-plugin-opener`. Lien simple
      uniquement (pas de deep-link possible, state React local côté
      poe2.re) — voir la note CHANGELOG "Unreleased".
- [ ] **Retour utilisateur passif** : quand un skip contredit le score
      (score élevé mais danger « Very Dangerous »), proposer discrètement
      « tu as passé celle-là à cause du danger ? ». Sert à calibrer les
      seuils avec du vrai comportement plutôt qu'avec des guides.

### Accessibilité

- [ ] **Audit de contraste** de la palette or/rouge sur fond sombre
      (WCAG AA), et une palette de repli à fort contraste pour les
      daltonismes et la sensibilité à la lumière. C'est le point le plus
      concret de ce thème : l'app est dense et repose beaucoup sur la
      couleur pour distinguer les tiers.
- [ ] **Navigation au clavier** complète (Tab entre les boutons, Entrée
      pour valider). Escape ferme déjà l'overlay.
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
- [ ] **Étendre le schéma de confiance des tablettes aux mécaniques** :
      `tablets.ts` a déjà `confidence: "high"/"medium"/"low"` et
      `source: "wiki"/"poe2db"/"community"/"manual"` par entrée — rien
      d'équivalent n'existe sur `MechanicDef` (mechanics.ts) pour tracer
      d'où vient chaque `priorityStat`. Si ça se fait, réutiliser
      exactement ce vocabulaire plutôt qu'en inventer un second à côté.
      Permettrait un écran « Settings → Data Quality » listant ce qui est
      sourcé vs deviné (Temple/Irradiated : 0 source, cf. l'item Atlas
      Master ci-dessus) — à distinguer de la télémétrie ci-dessous : ceci
      n'est que de la provenance statique, pas de la collecte runtime.
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

- [ ] **Journalisation structurée** côté Rust, avec export depuis les
      Réglages — pour diagnostiquer à distance, à commencer par le bug
      écran noir. Ne doit rien coûter au chemin chaud. (Pas Winston/Pino :
      ce sont des bibliothèques Node, inadaptées au côté Rust où le log
      doit vivre — `tracing` est l'équivalent de l'écosystème.)
- [ ] **Surveillance de `meta.json`** : recharger automatiquement quand le
      fichier change sur le disque. L'éditeur in-app recharge déjà à chaud
      ce qu'il écrit (`meta-config.ts`) — ce qui manque, c'est le cas de
      l'édition manuelle du fichier hors de l'app, qui exige encore un
      redémarrage.
- [ ] **Temps de démarrage** : profiler et vérifier si les données de
      tablettes sont reparsées à chaque `analyze()` ; si oui, mettre en
      cache après le premier parse.
- [ ] **Mode debug** (`OVERLAY_DEBUG=1`) : un coin de l'overlay affichant
      mods parsés / score / temps de rebuild, pour itérer sur les formules
      sans redémarrer.
- [ ] **Bouton « Valider meta.json »** dans les Réglages, indiquant la
      ligne fautive — évite les cycles reset + redémarrage.
- [ ] **Micro-infobulles** sur chaque stat du Heat Breakdown (« Pack Size :
      favorise les mécaniques denses comme Delirium »), en complément du
      Guide qui explique déjà le scoring d'ensemble.

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
