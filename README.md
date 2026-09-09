# 🚀 raganyllm Studio

> **Universal Local RAG Studio CLI & Standalone Model Builder for Ollama**

`raganyllm` is a powerful, local Retrieval-Augmented Generation (RAG) platform that turns any installed Ollama LLM into a specialized RAG assistant. It features real-time percentage progress loaders, persistent external SSD model storage, 1-click standalone Ollama model creation, and an integrated model manager.

---

## ✨ Features

- 🤖 **Universal Ollama Model Support**: Works seamlessly with any model installed in Ollama (`llama3`, `mistral`, `gemma`, `deepseek-r1`, `qwen2`, `phi3`, etc.).
- 💾 **External SSD & Custom Directory Support**: Specify and save custom model storage paths (e.g. `E:\ollama_models` or `/Volumes/ExternalSSD/ollama_models`) persistently across restarts.
- 📊 **Real-time % Progress Loaders**: Track exact progress (0% ➔ 100%) during document chunking & embedding generation across all 3 ingestion options:
  1. **Upload Files** (`.pdf`, `.md`, `.txt`)
  2. **Web Page URL Scraping**
  3. **Raw Markdown / Text Entry**
- 🚀 **1-Click Standalone Ollama Model Creation**: Bake your Knowledge Base directly into a standalone Ollama model (e.g., `angular29-lfm:latest` or `my-custom-rag:latest`) so you can run it directly in your terminal via `ollama run`!
- 🎛️ **Live RAG Toggle**: Easily switch **"Inject Live RAG Context"** ON or OFF to compare raw base model responses vs. RAG-boosted answers.
- ⚙️ **Settings & Model Manager**: Click the gear icon (`⚙️`) to manage installed Ollama models and delete unwanted custom models directly from storage.
- 🔌 **Automatic Port Fallback**: Automatically switches from port `8000` ➔ `8001` if port 8000 is occupied by another process.
- 🔒 **Local-first & Safe**: The server binds to `127.0.0.1` only and rejects state-changing requests from untrusted web pages — no more open CORS that let random websites drive your local Ollama.
- 💾 **User Data in `~/.raganyllm`**: Your knowledge base and settings now live in `~/.raganyllm/` (or `$RAGANYLLM_HOME` if set) instead of the current folder — so a global `npm install -g` works from anywhere and two app instances can't corrupt each other's files. Duplicate document chunks are detected and skipped automatically.
- 🔎 **Hybrid Search Mode**: ⚙️ Settings → switch from pure semantic search to **Hybrid** (BM25 keywords + semantic vectors, fused) — recovers exact names, versions and identifiers that vector-only search misses.
- 📦 **Portable Knowledge Packs (`.raganyllm`)**: One click **⬆ Export KB** saves your whole knowledge base — content *and* embeddings — into a single file. On any other device with raganyllm, click **⬇ Import KB**, choose **Merge** (duplicates skipped) or **Replace**, and you're done. Compact (text-only) exports are also supported and re-learn embeddings on import via Ollama. **🔒 Protect a pack with a password** before sharing — imports then ask for the password (AES-256-GCM).
- ⌨️ **CLI parity** — `raganyllm export ./backup.raganyllm [--password …] [--no-embeddings]` and `raganyllm import ./backup.raganyllm [--mode merge|replace] [--password …]` read and write the exact same packs as the buttons above (shared codec); plain `raganyllm` still launches the studio.
- 💾 **Auto-backups & restore** — Clear KB and Replace-imports snapshot your knowledge base first (rotating keep-last-10 in `~/.raganyllm/backups`); a 💾 **Back up now** button and timestamped **restore** list sit beside Export/Import KB.

---

## ⚙️ Prerequisites

Before running `raganyllm`, ensure you have:

1. **[Node.js](https://nodejs.org/)** (v18.0.0 or higher)
2. **[Ollama](https://ollama.com/)** installed and running on your system (`ollama serve` or open the Ollama Desktop app).

---

## 🚀 How to Run

### Method 1: Using `npx` (No installation needed)
```bash
npx raganyllm
```

### Method 2: Global NPM Installation
```bash
npm install -g raganyllm
raganyllm
```

### Method 3: Running Locally from Source Code
1. Clone or navigate to the project directory:
   ```bash
   cd RAG
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Start the application:
   ```bash
   npm start
   ```

`raganyllm` will automatically check your Ollama connection, verify that the lightweight `nomic-embed-text` embedding model is ready, spin up the server, and open `http://localhost:8000` (or `8001`) in your default web browser!

---

## 📖 Step-by-Step User Guide

### 1. Select Your Target LLM
At the top of the sidebar, choose any installed Ollama model from the **Select Target Ollama LLM** dropdown (e.g., `llama3:latest`, `liquidAI/lfm2.5-1.2b-instruct:latest`, etc.).

---

### 2. Configure Custom Directory / External SSD (Optional)
If your Ollama models are stored on an external drive:
1. Locate the **Custom Ollama Models Directory** card in the sidebar.
2. Enter your path (e.g. `E:\ollama_models`).
3. Click **Save**. The app will remember this setting until changed and automatically discover models stored on your external drive.

---

### 3. Add Documents to Knowledge Base
Choose one of the 3 ingestion tabs:
- 📄 **Upload Files**: Select one or multiple `.pdf`, `.md`, or `.txt` files and click **Upload & Ingest File(s)**.
- 🌐 **Web URL**: Enter any web documentation link (e.g. `https://angular.dev/overview`) and click **Scrape & Ingest URL**.
- 📝 **Text / MD**: Type or paste raw text/markdown notes and click **Ingest Text**.

Watch the glowing progress bar update in real-time from **0% ➔ 100%**!

---

### 4. Interactive RAG Chat
- Type your question in the chat footer and hit **Send**.
- `raganyllm` performs vector search across your Knowledge Base, retrieves top matching snippets, and feeds them to your selected model.
- Click **"🔍 Retrieved Knowledge Base Sources"** underneath any answer to inspect matched snippets and similarity scores.
- **Tip**: Uncheck **"Inject Live RAG Context"** at the top right to query the raw base model directly and compare outputs!

---

### 5. Create Standalone Ollama Model (Terminal CLI Ready)
Want to run your RAG model directly inside your terminal command line?
1. Under **"Create Standalone Ollama RAG Model"**, enter a new model name (e.g., `angular29-lfm:latest` or `test-ai:new`).
2. Click **🚀 Build & Create Ollama Model**.
3. Once the build progress reaches **100%**, open any terminal window and run:
   ```bash
   ollama run angular29-lfm:latest
   ```
   *Your custom model now has your knowledge base embedded inside its Modelfile!*

---

### 6. Settings & Deleting Custom Models
1. Click the **⚙️ Settings** gear icon in the header.
2. View all installed models.
3. Click **🗑️ Delete** next to any model to permanently remove unwanted or temporary standalone models from disk storage.

---

## 📦 How to Publish to NPM

To publish this project to the public npm registry:

1. **Log in to NPM**:
   ```bash
   npm login
   ```
2. **Publish**:
   ```bash
   npm publish
   ```
   *(Note: Ensure your `package.json` package `"name"` is unique before publishing).*

---

## 📁 Project Structure

```text
raganyllm/
├── bin/
│   └── cli.js            # CLI entrypoint script
├── lib/
│   ├── checker.js        # Ollama connection & model scanner
│   ├── config.js         # Configuration manager (~/.raganyllm/raganyllm-config.json)
│   ├── installer.js      # Interactive prerequisite setup
│   ├── paths.js          # User-data directory resolution (~/.raganyllm or $RAGANYLLM_HOME)
│   ├── server.js         # Express server & API endpoints
│   └── vector-store.js   # Local JSON vector store & chunker (content-deduplicated)
├── public/
│   └── index.html        # Web UI (Glassmorphic UI + Progress Loaders + Modal)
├── README.md             # Project documentation
├── package.json          # NPM configuration & executable bin script
└── .npmignore            # NPM publish exclusion rules
```

---

## 📜 License

[MIT](LICENSE) - Feel free to modify and distribute!
