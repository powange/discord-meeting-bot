# Stockage des comptes rendus (Google Drive, OneDrive, Dropbox)

[← Retour au README](../README.md)

Chaque serveur Discord peut copier automatiquement ses comptes rendus, transcriptions et audios dans un Google Drive, un OneDrive ou un Dropbox, dans un dossier par réunion.

## Pour les administrateurs d'un serveur Discord

1. `/config` → ☁️ **Stockage** → « Connecter … », puis connexion avec le compte de son choix (celui de l'association, par exemple). Le bot n'expose aucune page web, la connexion se fait donc ainsi :
   - **Google Drive, OneDrive** : le bot affiche un code ; on l'entre sur google.com/device ou microsoft.com/devicelogin, puis on autorise l'accès. Le panneau se met à jour tout seul.
   - **Dropbox** : « Ouvrir la page », autoriser l'accès, puis « Saisir le code » et coller le code affiché par Dropbox.
2. Ensuite, dans le même panneau :
   - 🧪 **Tester** : vérifie que le stockage est accessible ;
   - 📂 **Ouvrir le dossier** ;
   - 📁 **Changer de dossier** : démarre un nouveau dossier racine sous un autre nom (« Meeting recorder » par défaut, créé à la racine) ;
   - 🔌 **Déconnecter** : les fichiers déjà copiés restent.

Chaque compte rendu est copié dans `<dossier>/<date heure - titre>/` : compte rendu et transcription en Markdown, audio complet. Une correction, une régénération ou une nouvelle session remplace les fichiers.

**Dossier partagé** : sur Google Drive et OneDrive, il suffit de déplacer le dossier « Meeting recorder » dans un dossier partagé ou un Drive partagé de l'organisation, ou de le partager. Le bot le suit par son identifiant et continue d'y écrire. S'il est supprimé, il est recréé à la racine.

**Accès au plus juste** :

- Google Drive ne laisse voir au bot que les fichiers qu'il a créés (`drive.file`) ;
- Dropbox le limite à `Applications/<nom de l'application>` ;
- OneDrive n'a pas de réglage équivalent qui marche partout : l'accès porte sur le OneDrive, le bot n'écrit que dans son dossier.

Les jetons sont chiffrés avec `APP_SECRET_KEY`. Les règles de confidentialité sont sur https://meeting-recorder.powange.com/confidentialite.html.

## Pour l'opérateur du bot : créer les applications OAuth

Une seule fois par service : créer l'application OAuth du bot et mettre ses identifiants dans les variables de la stack (ou dans `storage` du YAML, voir [config/config.example.yaml](../config/config.example.yaml)), puis redéployer. Un service sans identifiant n'est pas proposé dans `/config`.

### Google Drive (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`)

Sur [console.cloud.google.com](https://console.cloud.google.com) :

1. Créer un projet dédié (par exemple « Meeting recorder »), puis *API et services → Bibliothèque* : activer **Google Drive API**.
2. *Google Auth Platform → Branding* :
   - nom de l'application, adresse d'assistance et coordonnées du développeur ;
   - **pas de logo** : avec un logo, Google exige une validation de plusieurs jours ;
   - page d'accueil et règles de confidentialité sur un domaine qui vous appartient (ici `https://meeting-recorder.powange.com/` et `…/confidentialite.html`, servis par GitHub Pages depuis le dossier `site/`) ; Google refuse `github.com` ;
   - domaine autorisé (ici `powange.com`), dont la propriété doit être vérifiée dans [Search Console](https://search.google.com/search-console) (propriété de type « Domaine », enregistrement TXT dans le DNS).
3. *Audience* : **Externe**. *Accès aux données* : ajouter la portée `…/auth/drive.file`.
4. **Publier l'application** (statut « En production »). En mode « Test », seuls les **utilisateurs test** déclarés peuvent se connecter et Google révoque l'accès au bout de 7 jours. `drive.file` n'est pas une portée sensible : il n'y a pas de validation de sécurité à demander à Google. Tant que l'application n'est pas validée, l'écran de connexion affiche « Google n'a pas validé cette application » : **Paramètres avancés** → **Accéder à Meeting recorder**.
5. *Clients → Créer un client* : type **Téléviseurs et appareils à entrée limitée**. Copier l'ID client et le code secret.

### OneDrive (`ONEDRIVE_CLIENT_ID`)

Sur [entra.microsoft.com](https://entra.microsoft.com) → *Inscriptions d'applications → Nouvelle inscription* :

1. Comptes pris en charge : **comptes de tout annuaire organisationnel et comptes Microsoft personnels** ; pas d'URI de redirection.
2. *Authentification* : **Autoriser les flux clients publics** → Oui.
3. *Autorisations d'API* : Microsoft Graph, délégué, `Files.ReadWrite` et `offline_access`.
4. Copier l'**ID d'application (client)**. Il n'y a pas de secret à créer. Avec un compte professionnel, l'administrateur de l'organisation peut devoir approuver l'application.

### Dropbox (`DROPBOX_APP_KEY`)

Sur [dropbox.com/developers/apps](https://www.dropbox.com/developers/apps) → *Create app* :

1. **Scoped access**, **App folder**, puis un nom : le dossier sera `Applications/<nom>`.
2. Onglet *Permissions* : cocher `files.content.write`, puis *Submit*.
3. Copier l'**App key**. Pas de secret ni d'URI de redirection : la connexion utilise PKCE. En mode développement, une application Dropbox accepte jusqu'à 500 comptes.
