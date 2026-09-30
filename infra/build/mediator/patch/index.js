import '@openwallet-foundation/askar-nodejs';
import { DidCommOutOfBandRepository, DidCommOutOfBandRole, DidCommOutOfBandState, } from '@credo-ts/didcomm';
import { createAgent } from './agent.js';
import { config } from './config.js';
function logInvitationUrl(agent, outOfBandRecord) {
    const httpEndpoint = config.agentEndpoints.find((e) => e.startsWith('http'));
    if (!httpEndpoint) {
        throw new Error('No HTTP endpoint configured for invitation generation');
    }
    const mediatorInvitationUrlLong = outOfBandRecord.outOfBandInvitation.toUrl({
        domain: config.invitationUrl,
    });
    agent.config.logger.info(`Out of band invitation url:\n\n\t${mediatorInvitationUrlLong}`);
}
async function createMediatorInvitation(agent) {
    return agent.didcomm.oob.createInvitation({
        multiUseInvitation: true,
        goalCode: config.invitationGoalCode,
        goal: 'Mediator Invitation',
    });
}
// 12id patch (Phase 7 review L6, -p6): with ADMIN_API_TOKEN set, every holder connects through a
// single-use invitation the platform API mints (POST /admin/invitations), so the open multi-use
// startup invitation only lets anyone who has seen a log line take mediation. It is neither created
// nor logged, and any reusable invitation left from earlier starts is deleted, so a URL already in
// old logs stops working. Connections made through it keep their records and stay mediated; an
// OOB record only matters while a handshake is in progress. Without the token, upstream behaviour.
async function retireStartupInvitations(agent) {
    const oobRepo = agent.dependencyManager.resolve(DidCommOutOfBandRepository);
    const open = await oobRepo.findByQuery(agent.context, {
        state: DidCommOutOfBandState.AwaitResponse,
        role: DidCommOutOfBandRole.Sender,
    });
    const reusable = open.filter((oobRecord) => oobRecord.reusable);
    for (const oobRecord of reusable) {
        await oobRepo.delete(agent.context, oobRecord);
    }
    agent.config.logger.info(`Startup invitation disabled (ADMIN_API_TOKEN is set); retired ${reusable.length} reusable invitation(s)`);
}
void createAgent().then(async (agent) => {
    agent.config.logger.info('Agent started');
    const adminApiToken = process.env.ADMIN_API_TOKEN;
    if (adminApiToken && adminApiToken.length >= 32) {
        return retireStartupInvitations(agent);
    }
    if (config.createNewInvitation) {
        agent.config.logger.info('Recreating out of band invitation');
        const outOfBandRecord = await createMediatorInvitation(agent);
        return logInvitationUrl(agent, outOfBandRecord);
    }
    const oobRepo = agent.dependencyManager.resolve(DidCommOutOfBandRepository);
    const outOfBandRecords = await oobRepo.findByQuery(agent.context, {
        state: DidCommOutOfBandState.AwaitResponse,
        role: DidCommOutOfBandRole.Sender,
    });
    let outOfBandRecord = outOfBandRecords
        .filter((oobRecord) => oobRecord.reusable)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    if (outOfBandRecord) {
        agent.config.logger.info('Reusing existing out of band invitation');
    }
    else {
        agent.config.logger.warn('No reusable out of band invitation found, creating a new one');
        outOfBandRecord = await createMediatorInvitation(agent);
    }
    logInvitationUrl(agent, outOfBandRecord);
});
//# sourceMappingURL=index.js.map
