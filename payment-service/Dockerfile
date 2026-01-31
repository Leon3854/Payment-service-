FROM node:20-alpine AS development


WORKDIR /app

# Копируем зависимости
COPY package*.json ./
COPY prisma ./prisma/

# Устанавливаем зависимости и генерируем Prisma
# RUN npm ci && npx prisma generate
RUN npm install

# Копируем исходный код
COPY . .

# Собираем приложение
# RUN npm run build

# Экспонируем порт
EXPOSE 3000

# Запуск
CMD ["npm", "run", "start:dev"]