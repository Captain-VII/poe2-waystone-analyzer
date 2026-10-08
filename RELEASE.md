# Publier une version

Rien n'atteint les joueurs tant qu'un tag `v*` n'est pas poussé. Les données
de jeu (`data/game-data.json`) sont l'exception : elles partent dès qu'elles
sont sur `main`, sans release (voir [data/SOURCES.md](data/SOURCES.md)).

## 1. Préparer

```bash
git checkout main && git pull
npm run bump -- 1.0.1            # ou 1.0.1-beta.1 pour une beta
```

`npm run bump` met la version dans les 5 fichiers (package.json,
package-lock.json, tauri.conf.json, Cargo.toml, Cargo.lock) et ouvre la
section `## 1.0.1` dans CHANGELOG.md. Écrire dessous les notes **pour les
joueurs, en anglais** (elles s'affichent dans l'app et sur la release).

```bash
git commit -am "Bump version to 1.0.1"
git push origin main
```

## 2. Attendre la CI

Le push sur `main` lance deux workflows :
- **CI** : lint, tests, build, tests visuels, clippy. Doit être vert.
- **Release cache** : précompile la release (~7 min). Taguer après sa fin
  divise le temps de release par ~3 ; avant, ça marche quand même, juste
  plus lentement.

## 3. Taguer

```bash
git tag v1.0.1 && git push origin v1.0.1
```

Le workflow Release :
1. refuse un tag qui ne correspond pas à package.json / tauri.conf.json, ou
   sans section CHANGELOG ;
2. attend que la CI de ce commit soit verte (échoue sinon) ;
3. construit et signe l'installeur NSIS, publie la release (pre-release si
   le tag contient `-`) ;
4. met à jour le flux de mise à jour : `updater-beta` à chaque tag,
   `updater` (stable) seulement pour un tag sans suffixe.

## 4. Vérifier (avant une version stable)

Installer depuis la release (pas `tauri dev`) et vérifier :

- [ ] L'overlay apparaît en haut à droite, pas noir. Dans Export Logs :
      `render-check: window renders fine`.
- [ ] **Ins** sur un vrai Waystone en jeu affiche son score. Deux fois de
      suite (le cas « marche une fois, pas deux »).
- [ ] **Ins** sur un autre objet : « Not a Waystone », rien ne casse.
- [ ] Clic dans le jeu : l'overlay se cache. Le bouton pin l'en empêche.
- [ ] Réglages : chaque onglet s'ouvre ; aucune ligne `csp-violation` dans
      les logs.
- [ ] Mise à jour : une installation de la version précédente propose
      celle-ci (canal beta pour une beta).

Astuce si on scripte Ins : donner le focus au jeu ou au Bloc-notes avant, un
terminal au premier plan reçoit le Ctrl+C simulé.

## Si ça casse

- **CI rouge sur main** : corriger dans une PR et merger. Ne jamais réécrire
  l'historique de `main`.
- **Release ratée avant publication** : supprimer le tag, corriger, retaguer.
  ```bash
  git tag -d v1.0.1 && git push origin -d v1.0.1
  ```
- **Version publiée défectueuse** : publier un correctif avec une version
  supérieure (`1.0.2`). Une version inférieure n'est jamais proposée en
  mise à jour.

## Versions

- PATCH `1.0.0 → 1.0.1` : correctif. MINOR `1.0.0 → 1.1.0` : fonctionnalité.
- Beta : suffixe `-beta.N`, uniquement pour les joueurs ayant activé le
  canal Beta.
