# hao-backprop-test

A simple Express.js HTTP server that serves two plaintext endpoints. Built as a tutorial project demonstrating basic Express routing.

## Endpoints

The server listens on `http://127.0.0.1:3000/` and exposes the following routes:

| Method | Path | Response |
|--------|------|----------|
| GET | `/` | `Hello, World!\n` |
| GET | `/good-evening` | `Good evening` |

## Getting Started

### Install dependencies

```bash
npm install
```

### Start the server

```bash
npm start
```

The server will start and log:

```
Server running at http://127.0.0.1:3000/
```
