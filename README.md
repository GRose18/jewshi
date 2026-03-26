# EW Markets — Backend

A Node.js + Express + SQLite backend for the Emery Weiner school prediction market.

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Start the server
```bash
npm start
```
The server runs at **http://localhost:3000**

For auto-restart on file changes (development):
```bash
npm run dev
```

---

## Accounts

| Role    | ID          | Password    |
|---------|-------------|-------------|
| Admin   | GROSE       | BryceB0mb!  |
| Student | STUDENT-001 | daren       |
| Student | STUDENT-002 | Hello123    |
| Student | STUDENT-003 | BigIce      |

> Passwords are hashed with bcrypt. The database is auto-created on first run.

---

## File Structure

```
ew-markets/
├── server.js         ← main backend
├── ew-markets.db     ← SQLite database (auto-created)
├── package.json
├── README.md
└── public/
    └── index.html    ← put your frontend HTML here
```

---

## API Reference

### Auth
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/login` | Login → returns JWT token |
| POST | `/api/auth/register` | Register new student |

### Markets
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/markets` | List all markets |
| GET | `/api/markets/:id` | Get one market |
| POST | `/api/markets` | Create market (admin) |
| POST | `/api/markets/:id/resolve` | Resolve YES/NO (admin) |
| POST | `/api/markets/:id/close` | Close betting (admin) |

### Bets
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/bets` | Place a bet |
| GET | `/api/bets/mine` | My bets |

### Store
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/store` | List store items |
| POST | `/api/store` | Add item (admin) |
| DELETE | `/api/store/:id` | Remove item (admin) |
| POST | `/api/store/:id/redeem` | Redeem item |
| GET | `/api/store/redemptions/mine` | My redemption history |

### Volunteer
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/volunteer` | Submit hours |
| GET | `/api/volunteer/mine` | My submissions |
| GET | `/api/volunteer/pending` | Pending approvals (admin) |
| POST | `/api/volunteer/:id/approve` | Approve hours (admin) |
| POST | `/api/volunteer/:id/reject` | Reject submission (admin) |

### Admin
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/users` | List all students |
| POST | `/api/users/:id/add-credits` | Add credits to a user |
| POST | `/api/admin/distribute-credits` | Give credits to all students |
| POST | `/api/admin/volunteer-rate` | Set credits-per-hour rate |
| GET | `/api/admin/transactions` | Full transaction log |
| GET | `/api/admin/stats` | Dashboard stats |

---

## How Transactions Work

Every credit movement is recorded in the `transactions` table automatically:

- `signup_bonus` — new account created
- `bet_placed` — credits deducted when betting
- `bet_won` — payout credited when market resolves
- `redemption` — store item redeemed
- `volunteer_approved` — hours approved by admin
- `weekly_distribution` — admin distributes weekly credits
- `admin_grant` — manual credit addition

All bet placements and market resolutions use **SQLite transactions** so credits can never be lost or duplicated mid-operation.
