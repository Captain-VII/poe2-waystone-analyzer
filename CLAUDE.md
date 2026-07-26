# Guide du développeur & maintaineur

## Vue d'ensemble

**poe2-waystone-analyzer** est un overlay Tauri 2 (Rust + Vite/TypeScript) pour Path of Exile 2 qui analyse et score les Waystones. L'app tourne en arrière-plan, se lance avec Windows, et affiche des recommandations tactiques sur chaque waystone lorsque l'utilisateur appuie sur **Ins** (ou **Ctrl+E**).

**Branches :**
- `main` → production, releases stables et beta
- Feature branches (nommage libre) → avant merge sur main

**Cadence :**
- Pas de "release cycles" fixes — on pousse quand c'est stable et testé localement
- Tags = releases (automatique via GitHub Actions)

---

## Dev local vs. Release — bien distinguer

| | **Dev local** | **Release** |
|---|---|---|
| Commande | `npm run tauri dev` | tag Git (`git tag vX.Y.Z`) |
| Où ça tourne | ta machine, fenêtre debug | machine de l'utilisateur final |
| Build | non signé, non optimisé | signé, optimisé, via CI |
| Déclencheur | manuel, à volonté | push d'un tag uniquement |
| meta.json | `$APPCONFIG` local (dev) | `$APPCONFIG` de l'utilisateur |
| Update checker | ne fait rien (pas de release à checker) | actif, checke `updater`/`updater-beta` |
| `OVERLAY_DEBUG=1` | dispo (HUD debug) | jamais activé |

**Règle simple** : tant que tu n'as pas poussé un tag, rien n'atteint les utilisateurs. Coder/tester en local ne touche jamais la release. Seul `git push origin vX.Y.Z` déclenche un vrai build public.

---

## Workflow quotidien

### Branching & Commits

1. **Avant de coder** : brancher depuis `main`
   ```bash
   git checkout -b feature/ma-feature
   ```

2. **Commit messages** : titres courts, français OK pour le dev interne
   - ✅ `Fix: typo in settings panel`
   - ✅ `Add: validate meta.json on disk`
   - ✅ `Refactor: simplify scoring logic`
   - ❌ `stuff` ou `various fixes`

3. **Push & PR** : pousser la branche, ouvrir une PR, revue sommaire avant merge
   ```bash
   git push -u origin feature/ma-feature
   # Ouvrir PR sur GitHub
   # Revue rapide, merge
   ```

4. **Après merge** : supprimer la branche
   ```bash
   git branch -d feature/ma-feature
   git push origin -d feature/ma-feature
   ```

### Tests locaux (obligatoires avant push)

Avant de pousser, toujours lancer :

```bash
# Frontend
npm run test          # Vitest unit tests
npm run verify-adapter # Formules/adapter (script Node, pas de navigateur)
npm run test:visual   # Playwright, captures vs référence — voir note plus bas

# Rust backend
cargo test            # Tests unitaires Rust

# Linting
cargo fmt --check     # Format Rust
cargo clippy --all-targets -- -D warnings
```

`npm run test:visual` télécharge Chromium (~150MB) au premier lancement et est plus lent que les deux autres checks front — **obligatoire si le push touche `src/components/RelicPanel.ts` ou `src/styles/*`** (les seuls fichiers qui peuvent bouger des pixels), optionnel sinon. Le CI (`visual-checks`) le lance de toute façon à chaque push, donc rien n'échappe au filet même si on saute le run local sur un changement sans rapport (scoring, Rust, docs).

Si une check échoue, fixer localement, committer, re-tester, puis pousser.

CI va de toute façon refuser les commits qui échouent, mais c'est plus rapide de fixer localement.

---

## Versioning & Release

### Les 3 fichiers magiques (doivent toujours être en sync)

Quand tu bumpes la version, ces trois fichiers doivent avoir **exactement** le même numéro :

1. **`package.json`** → `"version": "0.4.0"`
2. **`src-tauri/Cargo.toml`** → `version = "0.4.0"` (ligne ~20)
3. **`src-tauri/tauri.conf.json`** → `"version": "0.4.0"` (ligne ~3)

Si un seul ne match pas, le CI refusera la release.

### Versioning scheme

On suit [Semantic Versioning](https://semver.org/) :

- **MAJOR.MINOR.PATCH** : `0.4.1`, `1.0.0`, etc.
  - MAJOR = changement incompatible (jamais pour un overlay, probablement jamais)
  - MINOR = nouvelle feature (ex: "pin tablets", "meta.json watch")
  - PATCH = bug fix (ex: "fix overflow on Full panel")

- **Beta tags** = suffixe `-beta.N` : `0.4.0-beta.1`, `0.4.0-beta.2`
  - Avant une release stable, tester la candidate en beta
  - Les beta et stable **ne se mélangent pas** (feeds séparés)

### Checklist avant release

1. **Remplir CHANGELOG.md** (section "Unreleased")
   - Titres courts, orienté joueur (pas de détails internes)
   - Format : `- **Feature/Fix**: court résumé` (voir exemples dans CHANGELOG.md)
   - Relire pour typos et clarté

2. **Bump la version** dans les 3 fichiers (package.json, Cargo.toml, tauri.conf.json)
   - Tous la même numéro exactement

3. **Committer les changements**
   ```bash
   git add CHANGELOG.md package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json
   git commit -m "Bump version to 0.4.1"
   git push origin main
   ```

4. **Tagger et pousser** (déclenche la release automatique)
   ```bash
   git tag v0.4.1              # stable (ex: v1.2.3)
   # OU
   git tag v0.4.1-beta.1       # beta (ex: v1.2.3-beta.1)
   git push origin v0.4.1      # ou v0.4.1-beta.1
   ```

5. **CI va** :
   - Checker que le tag match le CHANGELOG/package.json
   - Builder et signer l'executable (Tauri auto)
   - Publier sur la release GitHub
   - Upload `latest.json` sur le feed adéquat (`updater` pour stable, `updater-beta` pour beta)

6. **L'app se met à jour** (joueurs avec beta channel verront beta, autres verront stable)

### Beta vs. Stable

- **Stable** (`v0.4.1`) : pour tout le monde, c'est la recommendation par défaut
- **Beta** (`v0.4.1-beta.1`) : opt-in via Réglages → App → Beta channel
  - Pas de risque de contaminer les stable installs (feeds séparés)
  - Permet de tester avant de déclarer stable

---

## CI/CD & Automation

### .github/workflows/ci.yml

Chaque push ou PR :
- `checks` (ubuntu-latest) : lint, tests frontend (`npm run test`), build, adapter verification (`npm run verify-adapter`)
- `rust-checks` (windows-latest) : `cargo check`/`test`/`fmt --check`/`clippy -D warnings`
- `visual-checks` (windows-latest) : captures Playwright vs référence (`npm run test:visual`) — job séparé, tourne sur Windows (pas Linux) à cause des polices système du projet (Segoe UI, Palatino Linotype, Cascadia Mono)

Si l'une de ces checks échoue, le CI rouge et refuse le merge.

### .github/workflows/release.yml

Déclenché quand tu pushes un tag (`git tag v0.4.1 && git push origin v0.4.1`) :

1. Build l'executable (Tauri)
2. Signe l'MSI avec la clé privée (stockée en GitHub secret)
3. Extrait les bullets du CHANGELOG pour la description
4. Publie la release GitHub avec l'executable
5. Upload `latest.json` sur le feed :
   - **`updater`** (stable) si le tag est plain (`v0.4.1`)
   - **`updater-beta`** (beta) si le tag contient `-` (`v0.4.1-beta.1`)

L'**updater channels** : deux feeds indépendants (GitHub Releases).
- Au démarrage, l'app demande au feed adéquat si une update existe
- Stable ask `updater`, beta ask `updater-beta`
- Les deux peuvent avoir différentes versions sans risque de cross-contamination

---

## Architecture & Structure

### Répertoires clés

```
poe2-waystone-analyzer-v3/
├── src/                          # TypeScript (Vite/frontend)
│   ├── main.ts                   # Entrée, watchMetaFile, onCheckUpdate
│   ├── analyzer/
│   │   ├── scoring.ts            # Juice Score, Mechanic Match Score
│   │   ├── meta-config.ts        # loadMetaConfig, watchMetaFile
│   │   └── tablets.ts            # Tablet data + fit scoring
│   ├── components/
│   │   └── RelicPanel.ts         # UI principale (4 tabs, pinning, etc.)
│   ├── styles/                   # CSS global + component styles
│   └── overlaySettings.ts        # localStorage keys + helpers
│
├── src-tauri/                    # Rust (Tauri backend)
│   ├── src/lib.rs               # check_update_channel, log_frontend_report
│   ├── Cargo.toml               # Dependencies, version sync
│   └── tauri.conf.json          # Tauri config, version sync
│
├── docs/
│   ├── overlay-ui-spec.md        # Spec du layout (Full/Compact)
│   └── release-checklist.md      # Pre-release verification (legacy)
│
├── .github/workflows/
│   ├── ci.yml                    # Tests + linting
│   └── release.yml               # Build + sign + publish
│
├── CLAUDE.md                     # Ce fichier (TOI ES ICI)
├── README.md                     # Mode d'emploi utilisateur + algo Juice Score
├── CHANGELOG.md                  # Historique des releases
├── ROADMAP.md                    # Features futures (français)
├── KNOWN_ISSUES.md              # Recherche technique + historique bugs
└── BETA_NOTES.md                 # Guide programme beta (legacy)
```

### Fichiers clés pour comprendre le scoring

- **`src/analyzer/scoring.ts`** : formules du Juice Score et Mechanic Match Score
- **`README.md` § "How the Juice Score works"** : explication joueur
- **`KNOWN_ISSUES.md` §3** : historique de l'évolution du modèle

Pas de single "source of truth" pour le scoring — c'est volontaire, car :
- Le code est la vérité (scoring.ts)
- La doc joueur explique le "pourquoi" (README)
- L'historique trace les changements (KNOWN_ISSUES)

---

## Patterns importants

### Déterminer si on est dans Tauri ou navigateur

```ts
function isTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}
```

Utilisé pour les features Tauri-only (plugin-fs, plugin-opener, etc.). En mode dev browser, les features Tauri gracefully fail.

### Charger la config meta

```ts
import { loadMetaConfig, watchMetaFile } from "@/analyzer/meta-config";

const meta = await loadMetaConfig();  // Charge depuis $APPCONFIG/meta.json
const stopWatching = await watchMetaFile(() => {
  // Appelé quand le fichier change sur disk (external edit)
  overlay.refreshMetaEditor();
});
```

### Logger pour le support

```ts
import { invoke } from "@tauri-apps/api/core";

void invoke("log_frontend_report", { report: "mon message" });
```

Côté Rust, tout passe par `tracing` (voir `init_logging()` dans `lib.rs`) : stdout en dev (`tauri dev`), plus un fichier journal quotidien (`waystone-overlay.log`) dans `app_log_dir()`, en dev comme en release. Réglages → App → **Export Logs** ouvre ce dossier dans l'explorateur — c'est le moyen de récupérer les logs d'un testeur pour diagnostiquer à distance (ex: le bug écran noir, KNOWN_ISSUES.md §1).

**Règle de confidentialité** : le presse-papier peut contenir n'importe quoi de l'utilisateur (mot de passe, message perso), sans rapport avec le jeu — et ces logs sont maintenant exportables en un clic. Ne jamais logger de texte brut issu du presse-papier ou d'une saisie utilisateur ; seulement des métadonnées non-identifiantes (longueur, booléens, énums). Voir `logAnalyzeAttempt` dans `diagnostics.ts` (`clipLength`, pas `clipPreview`) pour le patron à suivre.

### Validation JSON

```ts
import { validateMetaFile } from "@/analyzer/meta-schema";

const result = validateMetaFile(jsonText);
if (result.ok) {
  // Valid
} else {
  console.error(result.message);  // Inclut line/column number
}
```

---

## Documentation Companion

Chaque doc a un rôle spécifique. Ne pas en dupliquer le contenu.

| Fichier | Audience | Contenu |
|---------|----------|---------|
| **README.md** | Joueurs + devs | Mode d'emploi, installation, algo Juice Score expliqué |
| **CHANGELOG.md** | Joueurs | Historique des releases (embarqué dans l'app) |
| **ROADMAP.md** | Devs | Features futures, priorités, notes d'implémentation (français) |
| **KNOWN_ISSUES.md** | Devs/chercheurs | Bugs ouverts, historique d'investigations, décisions architecturales |
| **BETA_NOTES.md** | Program bêta | Guidance (legacy, peu utilisé) |
| **CLAUDE.md** | Devs/maintainers | Toi, maintenant (workflow, release, regles) |

Si tu dois expliquer quelque chose :
- **"Comment utiliser?"** → README.md
- **"Qu'est-ce qui change?"** → CHANGELOG.md
- **"Qu'on va faire?"** → ROADMAP.md
- **"Pourquoi c'est comme ça?"** → KNOWN_ISSUES.md
- **"Comment on pousse?"** → CLAUDE.md (toi)

---

## Règles non-négociables

1. **App UI/notifications toujours en anglais**. Chat/ROADMAP peuvent être français, mais tout ce que l'utilisateur voit dans l'app est anglais (CHANGELOG, boutons, messages, etc.).

2. **Meta.json auto-reload sur edit externe**
   - L'app regarde `$APPCONFIG/meta.json` via `watchMetaFile()`
   - Si le fichier change (éditeur externe), les customizations se recharger automatiquement
   - Pas de "Settings → Reload" nécessaire

3. **Tests locaux obligatoires avant push**
   ```bash
   cargo test && npm run test && npm run verify-adapter
   cargo fmt --check && cargo clippy --all-targets -- -D warnings
   ```
   `npm run test:visual` en plus si le push touche `RelicPanel.ts`/`src/styles/*` (voir plus haut).
   Si tu oublies, CI te le fera remarquer, mais c'est lent. Mieux d'avoir un feedback local immédiat.

4. **Version bump = 3 fichiers en sync**
   - Si tu changes `package.json` mais oublies `tauri.conf.json`, la release échoue
   - Toujours checker les trois avant de taguer

5. **Toujours être bref.** Réponses courtes, droit au but, pas de pavés inutiles. Économiser les tokens.

6. **Working rules for Claude Code in this repo**
   - Read existing files before writing. Don't re-read unless changed.
   - Write complete solutions, test once, no over-engineering.
   - Thorough in reasoning, concise in output.
   - Skip files over 100KB unless required.
   - No sycophantic openers or closing fluff. No emojis or em-dashes.
   - Do not guess APIs, versions, flags, commit SHAs, or package names — verify by reading code or docs before asserting.

---

## Quand quelque chose casse

### CI est rouge

1. Lire le log de la workflow qui a échoué (Actions → latest run → logs)
2. C'est presque toujours une fmt/clippy/test failure
3. Fixer localement, committer, re-pousser

### Black screen en jeu

=> Voir **KNOWN_ISSUES.md §1** pour l'historique complet. TL;DR : c'est un bug de layering compositor Windows, difficile à reproduire et non encore fixé.

### Meta.json invalide

=> L'app affiche une validation error dans Settings → Meta. Valider et corriger le JSON avec le formulaire ou un éditeur externe.

### Updater cassé

=> Deux feeds indépendants (updater, updater-beta). Si tu dois revert, re-tag avec une version inférieure ou égale, elle ne sera jamais proposée d'upgrade.

---

## Questions fréquentes

**Q: Je dois faire un hotfix en prod, comment?**
A: Branch depuis `main`, fix, commit, PR, merge, tag `v0.4.1` (ou le numéro que tu veux). CI l'auto-publie.

**Q: Comment tester un build avant de le releaseer?**
A: Tag `-beta.1`, tester, puis si tout OK tag sans suffixe (`v0.4.1`). Les deux sont indépendants.

**Q: La version dans package.json est 0.4.0 mais Cargo.toml dit 0.3.9, c'est quoi?**
A: C'est un oubli ou un revert partagé. Sync les 3 fichiers avant de tagger. `grep "version" package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json` pour vérifier.

**Q: Meta.json watch ne marche pas.**
A: Vérifier que le fichier existe à `$APPCONFIG/meta.json`. En dev mode (`tauri dev`), c'est `$HOME/AppData/Roaming/poe2-waystone-analyzer/`. Le watch use la feature `notify-debouncer-full` (Rust), débounce 1s.

**Q: Je dois relancer l'app pour que mon changement de scoring prenne effet?**
A: Oui, pour le code (TypeScript/Rust). Pour meta.json customizations, non — l'app recharge automatiquement sans restart.

---

## Pour aller plus loin

- Voir **README.md** pour l'installation et le guide complet joueur
- Voir **ROADMAP.md** pour les features en cours/futures
- Voir **KNOWN_ISSUES.md** pour le contexte technique des bugs ouverts
- Voir **.github/workflows/** pour les détails CI/CD (trop techniques pour ici)

Bon coding. 🎮
