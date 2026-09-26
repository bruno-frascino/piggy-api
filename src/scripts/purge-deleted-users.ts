import { purgeExpiredAccounts } from '../lib/account-deletion.js'

const purged = await purgeExpiredAccounts()

console.log(
  purged.length === 0
    ? 'No accounts past their deletion grace period.'
    : `Purged ${purged.length} account(s): ${purged.join(', ')}`
)

process.exit(0)
