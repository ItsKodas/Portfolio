// Prisma's settings. DATABASE_URL comes from .env locally and from docker-compose.yml on the server. It can be unset
// for prisma generate, which is how the Docker build generates the client without a database.
import 'dotenv/config'
import { defineConfig } from 'prisma/config'

export default defineConfig({
    schema: 'prisma/schema.prisma',
    migrations: { path: 'prisma/migrations' },
    datasource: { url: process.env.DATABASE_URL },
})
