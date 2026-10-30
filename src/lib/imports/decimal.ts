import { Decimal } from 'decimal.js'

// Wide enough for 12-dp prices times 12-dp quantities without silent rounding.
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP })

export default Decimal
