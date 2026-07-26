# Release Checklist — Waystone Overlay

Simple checklist pour releaseer une nouvelle version. Suivi étape par étape, rien de plus.

---

## Avant de commencer

- [ ] Vous êtes sur `main` et tout est commité (`git status` propre)
- [ ] Aucun incident critique en cours
- [ ] Dernière version en prod fonctionne

## Phase 1 : Tests

```bash
npm test
npm run verify-adapter
npm run lint
cargo test
cargo clippy --all-targets
```

- [ ] npm test — PASS
- [ ] npm run verify-adapter — PASS
- [ ] npm run lint — PASS
- [ ] cargo test — PASS (ou OK si macOS)
- [ ] cargo clippy — PASS (ou OK si macOS)

## Phase 2 : CHANGELOG

- [ ] Section `## Unreleased` existe
- [ ] Au moins une entrée (Added/Fixed/Changed)
- [ ] Texte joueur-friendly, pas technique
- [ ] Pas de typos

## Phase 3 : Version (3 fichiers)

Bump **exactement les mêmes versions** dans :
- `package.json` (ligne ~4)
- `src-tauri/Cargo.toml` (ligne ~20)
- `src-tauri/tauri.conf.json` (ligne ~3)

Vérifier : `grep "version" package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json`

- [ ] Versions bumped
- [ ] Versions match

## Phase 4 : Commit & Push

```bash
git add CHANGELOG.md package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json
git commit -m "Bump version to 0.5.1"
git push origin main
```

- [ ] Commité
- [ ] Pushé

## Phase 5 : CI Check

GitHub → Actions → vérifier que CI passe (tous les checks vert)

- [ ] CI vert

## Phase 6 : Tag & Push

```bash
git tag v0.5.1
git push origin v0.5.1
```

Ou beta : `git tag v0.5.1-beta.1`

- [ ] Tag créé
- [ ] Tag pushé

## Phase 7 : Vérifier Release

GitHub → Releases → vérifier que v0.5.1 existe avec MSI.

**C'est bon ! Release est live.**

---

## Versioning

- **PATCH** : bugfix (`0.5.0` → `0.5.1`)
- **MINOR** : feature (`0.5.0` → `0.6.0`)
- **MAJOR** : breaking change (`0.5.0` → `1.0.0`)

Beta : `-beta.N` (ex: `0.5.1-beta.1`)

---

## Si ça casse

- CI rouge : `git reset --hard HEAD~1 && git push origin main --force` → fixer → recommencer
- Version pas sync : vérifier avec grep, corriger, recommitter
- Tag mal : `git tag -d v0.5.1 && git push origin -d v0.5.1` → refaire

Voilà. 🚀
