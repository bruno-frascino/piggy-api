import { initTRPC } from '@trpc/server'
import { z } from 'zod'
import superjson from 'superjson'
import { prisma } from './prisma.js'

// Create context for tRPC
export const createTRPCContext = async () => {
  return {
    prisma,
  }
}

export type Context = Awaited<ReturnType<typeof createTRPCContext>>

// Initialize tRPC
const t = initTRPC.context<Context>().create({
  transformer: superjson,
})

// Export router and procedure helpers
export const router = t.router
export const publicProcedure = t.procedure
