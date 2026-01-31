# Базовый образ
FROM node:20-alpine As development

# Установка пакетов для сборки зависимостей
# RUN apk add --no-cache python3 make g++

# Установка глобально пакетов
RUN npm install -g @nestjs/cli prisma

WORKDIR /usr/src/app

# Копируем package.json и package-lock.json
COPY package*.json ./
COPY prisma ./prisma/

# Устанавливаем зависимости
RUN npm ci

# Копируем исходный код
COPY . .

# Сборка приложения
RUN npm run build

FROM node:20-alpine As production

# Устанавливаем только необходимые пакеты
RUN apk add --no-cache dumb-init

WORKDIR /usr/src/app

ENV NODE_ENV production

# Копируем package.json и package-lock.json
COPY package*.json ./
COPY prisma ./prisma/

# Устанавливаем только production зависимости
RUN npm ci --only=production && npm cache clean --force

# Копируем скомпилированный код из stage сборки
COPY --from=development /usr/src/app/dist ./dist

# Генерируем Prisma Client
RUN npx prisma generate

# Меняем пользователя для безопасности
USER node

EXPOSE $PORT

# Используем dumb-init для корректной обработки сигналов
CMD ["dumb-init", "node", "dist/main.js"]