# My Savings Tracker

**My Savings Tracker** is a personal finance application designed to help you track deposits and withdrawals and watch your savings grow. It is built as a Progressive Web App (PWA) leveraging the Firebase platform for backend services.

## Features

- **Transaction Management**: Log income and expenses with timestamps.
- **Categorization**: Organize your transactions into custom categories.
- **PWA Support**: Installable on mobile and desktop devices with offline capabilities.
- **Secure**: User-based data isolation using Firebase Authentication and Firestore.

## Tech Stack

- **Frontend**: HTML, CSS, JavaScript (served via Firebase Hosting).
- **Backend**: Firebase (Firestore, Authentication).
- **Hosting**: Firebase Hosting.

## Project Structure

- `manifest.json`: Web App Manifest configuration for PWA features (icons, theme colors, etc.).
- `firebase.json`: Configuration for Firebase Hosting, Firestore rules, and indexes.
- `firestore.indexes.json`: Definitions for Firestore composite indexes required for querying transactions and categories.
- `package.json`: Project dependencies (primarily Firebase SDK).

## Getting Started

### Prerequisites

- Node.js
- Firebase CLI: `npm install -g firebase-tools`

### Installation

1.  **Clone the repository:**

    ```bash
    git clone <repository-url>
    cd finance
    ```

2.  **Install dependencies:**

    ```bash
    npm install
    ```

### Configuration

1.  **Firebase Login:**

    ```bash
    firebase login
    ```

2.  **Project Setup:**
    Ensure you have a Firebase project created in the Firebase Console.
    Link this local directory to your Firebase project:

    ```bash
    firebase use --add
    ```

### Deployment

To deploy the application to production:

```bash
firebase deploy
```

This command deploys the hosting assets, Firestore rules, and indexes.

## License

MIT