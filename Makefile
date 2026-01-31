# Makefile
.PHONY: help setup up down build test clean

help:
	@echo "Available commands:"
	@echo "  make setup     - Copy .env.example to .env and install dependencies"
	@echo "  make up        - Start all services with docker-compose"
	@echo "  make down      - Stop all services"
	@echo "  make build     - Build all services"
	@echo "  make test      - Run tests for all services"
	@echo "  make clean     - Remove node_modules, dist, docker images"
	@echo "  make logs      - Show logs for all services"
	@echo "  make migrate   - Run database migrations"

setup:
	@if [ ! -f .env ]; then \
		cp .env.example .env && \
		echo "Created .env file from .env.example"; \
	else \
		echo ".env already exists"; \
	fi
	@echo "Installing dependencies for all services..."
	@cd auth-service && npm ci
	@cd product-service07 && npm ci
	@cd payment-service19 && npm ci

up:
	docker-compose up -d

down:
	docker-compose down

build:
	docker-compose build

test:
	@echo "Testing auth-service..."
	@cd auth-service && npm test
	@echo "Testing product-service07..."
	@cd product-service07 && npm test
	@echo "Testing payment-service19..."
	@cd payment-service19 && npm test

clean:
	@echo "Cleaning up..."
	@rm -rf auth-service/node_modules auth-service/dist auth-service/coverage
	@rm -rf product-service07/node_modules product-service07/dist product-service07/coverage
	@rm -rf payment-service19/node_modules payment-service19/dist payment-service19/coverage
	@docker-compose down -v
	@docker system prune -f

logs:
	docker-compose logs -f

migrate:
	@echo "Running migrations..."
	@cd auth-service && npx prisma migrate deploy
	@cd product-service07 && npx prisma migrate deploy
	@cd payment-service19 && npx prisma migrate deploy

seed:
	@echo "Seeding database..."
	@cd auth-service && npx prisma db seed
	@cd product-service07 && npx prisma db seed
	@cd payment-service19 && npx prisma db seed