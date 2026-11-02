# MaxLibre 🚄 — les trains à 0 € de l'abonnement MAX

Site web (100 % statique, compatible GitHub Pages) qui affiche **sur une carte** toutes les gares
accessibles **gratuitement** avec l'abonnement **MAX JEUNE / MAX SENIOR** (places « TGV MAX » à 0 €).

## Utilisation

1. Choisis ta **gare de départ** (et/ou ta **gare d'arrivée**).
2. Choisis une **date** (sur les 30 prochains jours).
3. La carte affiche en vert toutes les gares atteignables à 0 €, avec les horaires.

Trois modes :

| Tu renseignes | Tu obtiens |
|---|---|
| Départ seul | Toutes les destinations possibles à 0 € ce jour-là |
| Arrivée seule | Toutes les gares d'où tu peux venir à 0 € |
| Départ + arrivée | Un calendrier sur 30 jours avec les jours où il reste des places, puis les horaires |

Filtres par moment de la journée, tri (plus de trains, plus rapide, plus tôt, A→Z),
clic sur une gare de la carte pour la choisir, et lien partageable (l'URL contient la recherche).

## Données

- Places à 0 € : jeu de données [SNCF Open Data « TGV MAX »](https://ressources.data.sncf.com/explore/dataset/tgvmax/)
  (interrogé en direct depuis le navigateur, actualisé quotidiennement par la SNCF).
- Position des gares : jeu de données [« Gares de voyageurs »](https://ressources.data.sncf.com/explore/dataset/gares-de-voyageurs/)
  + coordonnées intégrées dans `stations.js` pour les gares étrangères / « intramuros ».
- Fond de carte : © OpenStreetMap, via [Leaflet](https://leafletjs.com/).

Site non officiel, sans lien avec la SNCF.

## Lancer en local

```bash
python3 -m http.server 8000
# puis ouvrir http://localhost:8000
```

## Fichiers

- `index.html` — structure de la page
- `styles.css` — design (responsive mobile / ordinateur)
- `app.js` — recherche, carte, liste des trains
- `stations.js` — liste des gares et coordonnées de secours
