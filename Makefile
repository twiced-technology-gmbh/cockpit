.PHONY: dev prod build test typecheck

dev:
	pnpm dev

prod: build
	NODE_ENV=production pnpm start

build:
	pnpm build

test:
	pnpm test

typecheck:
	pnpm typecheck
