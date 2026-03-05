# 🏦 High-Availability Billing Engine (Evolution Project)

> **Статус: Глубокий архитектурный рефакторинг и переход на AI-Native инфраструктуру.**

Этот проект проходит путь трансформации от базового платежного сервиса к отказоустойчивой распределенной системе, готовой к Highload-нагрузкам и интеллектуальному анализу транзакций.

---

### 🚀 Что происходит сейчас?

Я провожу полную модернизацию системы, применяя накопленный опыт в проектировании распределенных систем. Основная цель — обеспечить **Transactional Integrity** (целостность данных) и **High Availability** (высокую доступность).

#### 📖 Документация эволюции:

Если вы хотите проследить за ходом инженерной мысли, изучите требования:

- [**REQUIREMENTS_OLD.md**](./REQUIREMENTS_OLD.md) — С чего всё начиналось (MVP, базовая логика).
- [**REQUIREMENTS_NEW.md**](./REQUIREMENTS_NEW.md) — Куда мы идем (Go, Kafka/RabbitMQ, Redis Locks, AI-AntiFraud, K8s).

---

### 🛠 Ключевые изменения (Highlights):

1.  **Polyglot Architecture:** Перенос критических узлов (процессинг платежей) на **Go (Golang)** для снижения Latency.
2.  **Consistency & Safety:** Внедрение распределенных блокировок **Redis (SET NX)** для защиты от Double-Spending (двойных списаний).
3.  **Messaging:** Переход на событийную архитектуру (**RabbitMQ/Kafka**) с гарантией доставки At-least-once.
4.  **AI-Driven Layer:** Интеграция нейросетей (**DeepSeek/Claude**) для автоматической категоризации расходов и интеллектуального антифрода.
5.  **Data Reliability:** Оптимизация PostgreSQL (Prisma) для работы с большими выборками и устранение проблемы **N+1**.

---

### 🏗 Стек технологий:

- **Backend:** Node.js (NestJS), Go (Golang)
- **Data:** PostgreSQL (Prisma), Redis (Caching & Locking)
- **Messaging:** RabbitMQ / Apache Kafka
- **API:** REST, GraphQL (для финансовой аналитики), WebSockets (Real-time статусы)
- **Infra:** Docker, Kubernetes (K8s ready), GitHub Actions (CI/CD)

---

_Проект открыт для Code Review и обсуждения архитектурных паттернов._
