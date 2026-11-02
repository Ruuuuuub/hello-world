# État des lieux vidéo horodaté

Application web (PWA, fonctionne hors-ligne, sans serveur) pour réaliser les états des lieux d'entrée et de sortie d'une location en vidéo.

## Fonctionnalités
- **Visite guidée pièce par pièce** : liste d'éléments à filmer par type de pièce (murs, sol, robinetterie…), chaque passage à l'élément suivant crée un chapitre dans la vidéo.
- **Vidéo horodatée** : la date, l'heure et le nom de la pièce sont incrustés directement dans l'image enregistrée.
- **Repérage des défauts** : un bouton extrait une photo horodatée du flux vidéo, note l'heure et la position dans la vidéo, la gravité et une description.
- **État de chaque élément** (neuf, bon, usage, mauvais, hors service) + commentaires, compteurs et clés.
- **Comparaison entrée / sortie** : une sortie liée à une entrée fait ressortir automatiquement les dégradations.
- **Signatures** bailleur et locataire sur l'écran, puis verrouillage.
- **Rapport daté** imprimable / exportable en PDF, avec empreinte **SHA-256** de chaque vidéo et du rapport (toute modification est détectable).
- Données stockées **uniquement sur l'appareil** (IndexedDB) ; export des vidéos et des données JSON.

## Utilisation
Ouvrir `etat-des-lieux/index.html` via HTTPS (ex. GitHub Pages) ou `localhost` — la caméra exige un contexte sécurisé.
En local : `python3 -m http.server` à la racine du dépôt puis http://localhost:8000/etat-des-lieux/
Sur mobile, « Ajouter à l'écran d'accueil » pour l'installer comme une application.
