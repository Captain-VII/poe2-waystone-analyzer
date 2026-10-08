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

### Version : `npm run bump`

La version vit dans 5 fichiers (package.json, package-lock.json,
tauri.conf.json, Cargo.toml, Cargo.lock). Ne jamais les éditer à la main :

```bash
npm run bump -- 1.0.1        # ou 1.0.1-beta.1
```

Le script les met tous à jour et ouvre la section `## 1.0.1` du CHANGELOG.
La release refuse un tag qui ne correspond pas à package.json/tauri.conf.json.

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

Tout est dans [RELEASE.md](RELEASE.md) : `npm run bump`, notes CHANGELOG
(anglais, pour les joueurs), push sur `main`, CI verte, tag. Le workflow
Release attend lui-même que la CI du commit tagué soit verte.

### Beta vs. Stable

- **Stable** (`v0.4.1`) : pour tout le monde, c'est la recommendation par défaut
- **Beta** (`v0.4.1-beta.1`) : opt-in via Réglages → App → Beta channel
  - Pas de risque de contaminer les stable installs (feeds séparés)
  - Permet de tester avant de déclarer stable

---

## CI/CD & Automation

### .github/workflows/ci.yml

Chaque PR, push sur `main`, et chaque lundi (run planifié, échec = mail) :
- `checks` (ubuntu-latest) : lint, tests (`npm run test`), build, `npm run verify-adapter`
- `rust-checks` (windows-latest) : `cargo check`/`test`/`fmt --check`/`clippy -D warnings`
- `visual-checks` (windows-latest) : captures Playwright (`npm run test:visual`), sur Windows pour les polices du projet (Segoe UI, Palatino Linotype, Cascadia Mono)

Rust est figé par `rust-toolchain.toml` (installé explicitement par chaque workflow) : une nouvelle version de Rust ne casse plus une release. Pour monter de version : changer le fichier, `cargo clippy`, corriger.

### .github/workflows/release-cache.yml

Chaque push sur `main` : `tauri build --no-bundle` pour sauvegarder le cache Rust release sous la clé partagée `release`. Un cache créé sur un tag n'est lisible que par ce tag, donc c'est `main` qui le prépare.

### .github/workflows/release.yml

Déclenché par un tag `v*` :
1. Vérifie tag = package.json = tauri.conf.json, et la section CHANGELOG
2. Attend que `ci.yml` soit vert sur le commit tagué (échoue sinon)
3. Build et signe l'installeur **NSIS** (signature updater minisign, pas d'Authenticode : SmartScreen prévient à l'installation)
4. Publie la release GitHub (pre-release si le tag contient `-`)
5. Met à jour `latest.json` : `updater-beta` à chaque tag, `updater` (stable) seulement sans suffixe

### Dependabot

Sécurité uniquement pour npm et cargo (PR groupées), GitHub Actions une PR groupée par mois. Pas de flot de PR de versions.

---

## Architecture & Structure

### Répertoires clés

```
poe2-waystone-analyzer/
├── src/                          # TypeScript (Vite/frontend)
│   ├── main.ts                   # Entrée, chargement game-data + meta.json, hotkeys
│   ├── analyzer/
│   │   ├── game-data.ts          # Validation + diffusion des données de jeu
│   │   ├── remote-game-data.ts   # Récupération du JSON sur main, cache
│   │   ├── scoring.ts            # Juice Score (dominant stat), dangers
│   │   ├── adapter.ts            # Score affiché = meilleur fit de tablette
│   │   ├── meta-config.ts        # meta.json : load, watch, save
│   │   └── tablets.ts            # Tablettes vérifiées + migration de noms
│   ├── components/
│   │   └── RelicPanel.ts         # UI principale
│   └── styles/
├── data/
│   ├── game-data.json            # Données de jeu, mises à jour sans release
│   └── SOURCES.md                # Procédure + provenance de chaque valeur
├── src-tauri/
│   ├── src/lib.rs                # run(), état partagé, petites commandes
│   ├── src/render.rs             # show/hide, détection + récupération écran noir
│   ├── src/hotkeys.rs            # raccourcis globaux
│   ├── src/input.rs              # Ctrl+C simulé, détection clic hors overlay
│   ├── src/updater.rs            # canaux stable/beta
│   ├── src/logging.rs            # logs fichier, panic hook
│   └── tauri.conf.json           # config Tauri, CSP
├── docs/
│   ├── overlay-ui-spec.md        # Spec UI
│   └── history/                  # Journal de dev + problèmes résolus (archives)
├── scripts/                      # verify-adapter, bump-version
├── README.md                     # Joueurs
├── CONTRIBUTING.md               # Devs : setup, checks, structure
├── RELEASE.md                    # Procédure de release
├── CHANGELOG.md                  # Notes de version (embarqué dans l'app)
├── ROADMAP.md                    # Statut 1.0 + idées
└── KNOWN_ISSUES.md               # Problèmes ouverts
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
| **CONTRIBUTING.md** | Devs | Setup, checks, structure |
| **RELEASE.md** | Mainteneur | Procédure de release, tests manuels, quoi faire si ça casse |
| **data/SOURCES.md** | Mainteneur | Mettre à jour les données de jeu sans release, provenance |
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

4. **Version bump = `npm run bump -- <version>`**
   - Jamais à la main : 5 fichiers à garder synchronisés

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

=> **KNOWN_ISSUES.md §1**. Cause hors de l'app (compositeur WebView2/GPU). Depuis 2026-10-08, `render.rs` le détecte par capture d'écran réelle et cache/réaffiche la fenêtre (2 essais max) après le démarrage et chaque Ins. Dans les logs : `RECOVERED from black frame` ou `still BLANK/BLACK after recovery attempts`.

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

**Q: Un patch PoE2 change un mod ou une plage de stat, je fais une release?**
A: Non : éditer `data/game-data.json`, incrémenter `revision`, merger sur `main`. Les apps le récupèrent au démarrage. Voir `data/SOURCES.md`.

**Q: Meta.json watch ne marche pas.**
A: Vérifier que le fichier existe à `%APPDATA%\com.captain-vii.waystone-analyzer\meta.json` (`$APPCONFIG`). Le watch passe par `tauri-plugin-fs` (`watchMetaFile`, délai 1s).

**Q: Je dois relancer l'app pour que mon changement de scoring prenne effet?**
A: Oui, pour le code (TypeScript/Rust). Pour meta.json customizations, non — l'app recharge automatiquement sans restart.

---

## Pour aller plus loin

- Voir **README.md** pour l'installation et le guide complet joueur
- Voir **ROADMAP.md** pour les features en cours/futures
- Voir **KNOWN_ISSUES.md** pour le contexte technique des bugs ouverts
- Voir **.github/workflows/** pour les détails CI/CD (trop techniques pour ici)

Bon coding. 🎮
