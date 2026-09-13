// MUST be imported before any @credo-ts/* package.
//
// `@openwallet-foundation/askar-shared` exports `askar` as undefined until the
// platform binding package registers itself. Credo's bundled build captures that
// binding at module-init time, so if a @credo-ts/* package is evaluated first the
// agent fails at runtime with "Cannot read properties of undefined (reading
// 'keyGetJwkSecret')". Same pattern applies to anoncreds and indy-vdr.
import { anoncreds } from '@hyperledger/anoncreds-nodejs'
import { indyVdr } from '@hyperledger/indy-vdr-nodejs'
import { askar } from '@openwallet-foundation/askar-nodejs'

export { anoncreds, askar, indyVdr }
