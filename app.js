import WebSocket, { WebSocketServer } from "ws";
import { createServer } from 'http';
import { v4 as uuidv4 } from 'uuid';

const server = createServer();
const wss = new WebSocketServer({ server });

// Data structures
const groups = new Map(); // groupId: { clients: Set, admins: Set, banned: Set }
const groupCodes = new Map(); // code: groupId
const contests = new Map(); // groupId: current contest
const contestHistory = new Map(); // groupId: Array of past contests
const rateLimits = new Map(); // userId: { count: number, lastReset: timestamp }

// Rate limiting config
const RATE_LIMIT = {
    max: 50, // Max messages per window
    windowMs: 60 * 1000 // 1 minute window
};

wss.on('connection', (ws, req) => {
    const urlParams = new URLSearchParams(req.url.split('?')[1]);
    const joinCode = urlParams.get('code');
    const userId = urlParams.get('userId') || `user_${uuidv4().slice(0, 8)}`;

    if (!joinCode || !groupCodes.has(joinCode)) {
        ws.close(1008, 'Invalid or missing join code');
        return;
    }

    const groupId = groupCodes.get(joinCode);
    let groupData = groups.get(groupId) || {
        clients: new Set(),
        admins: new Set([userId]),
        banned: new Set()
    };
    groups.set(groupId, groupData);

    if (groupData.banned.has(userId)) {
        ws.close(1008, 'You are banned from this group');
        return;
    }

    ws.userId = userId;
    ws.groupId = groupId;
    ws.isAdmin = groupData.admins.has(userId);
    groupData.clients.add(ws);

    broadcastToGroup(groupId, {
        type: 'welcome',
        message: `Welcome ${userId} to group ${groupId}!`,
        members: groupData.clients.size,
        isAdmin: ws.isAdmin
    }, ws);

    ws.on('message', (data) => {
        try {
            if (!checkRateLimit(userId)) {
                ws.send(JSON.stringify({
                    type: 'error',
                    message: 'Rate limit exceeded. Please wait.'
                }));
                return;
            }

            const parsedData = JSON.parse(data);
            const groupData = groups.get(ws.groupId);
            const contest = contests.get(ws.groupId);

            switch (parsedData.type) {
                case 'chat':
                    broadcastToGroup(ws.groupId, {
                        type: 'chat',
                        userId: ws.userId,
                        message: parsedData.message
                    });
                    break;

                case 'start_contest':
                    if (!contest || contest.status === 'ended') {
                        startContest(ws, parsedData);
                    }
                    break;

                case 'submit_contest':
                    submitContest(ws, parsedData, contest);
                    break;

                case 'end_submission':
                    endSubmission(ws, parsedData, contest);
                    break;

                case 'vote':
                    submitVote(ws, parsedData, contest);
                    break;

                case 'end_voting':
                    endVoting(ws, contest);
                    break;

                case 'get_history':
                    sendContestHistory(ws);
                    break;

                case 'promote_admin':
                case 'kick':
                case 'ban':
                    handleAdminActions(ws, parsedData);
                    break;
            }

            if (contest) {
                checkContestDeadlines(ws.groupId, groupData);
            }
        } catch (error) {
            console.error('Message handling error:', error);
        }
    });

    ws.on('close', () => cleanupClient(ws));
});


function startContest(ws, data) {
    const duration = Math.min(data.duration || 5 * 60 * 1000, 60 * 60 * 1000); 
    const contest = {
        creator: ws.userId,
        startedAt: Date.now(),
        submissions: new Map(),
        votes: new Map(),
        status: 'submission',
        submissionDeadline: Date.now() + duration,
        votingDeadline: null,
        votingDuration: Math.min(data.votingDuration || 5 * 60 * 1000, 30 * 60 * 1000)
    };
    contests.set(ws.groupId, contest);
    broadcastToGroup(ws.groupId, {
        type: 'contest_started',
        creator: ws.userId,
        submissionDeadline: contest.submissionDeadline
    });
}

function submitContest(ws, data, contest) {
    if (contest && contest.status === 'submission' && Date.now() < contest.submissionDeadline) {
        contest.submissions.set(ws.userId, {
            submission: data.submission.slice(0, 1000), // Limit submission size
            timestamp: Date.now()
        });
        ws.send(JSON.stringify({
            type: 'submission_received'
        }));
    }
}

function endSubmission(ws, data, contest) {
    if (contest && contest.creator === ws.userId && contest.status === 'submission') {
        contest.status = 'voting';
        contest.votingDeadline = Date.now() + contest.votingDuration;
        broadcastVotingStart(ws.groupId, contest);
    }
}

function submitVote(ws, data, contest) {
    if (contest && contest.status === 'voting' && Date.now() < contest.votingDeadline) {
        const { targetUserId, score } = data;
        if (!contest.submissions.has(targetUserId) || ws.userId === targetUserId || score < 1 || score > 10) return;

        if (!contest.votes.has(ws.userId)) contest.votes.set(ws.userId, new Map());
        contest.votes.get(ws.userId).set(targetUserId, score);
        ws.send(JSON.stringify({ type: 'vote_received' }));
    }
}

function endVoting(ws, contest) {
    if (contest && contest.creator === ws.userId && contest.status === 'voting') {
        endContest(ws.groupId, groups.get(ws.groupId));
    }
}

function endContest(groupId, groupData) {
    const contest = contests.get(groupId);
    contest.status = 'ended';

    const scores = calculateScores(contest);
    const results = Array.from(scores.entries())
        .map(([userId, totalScore]) => ({
            userId,
            submission: contest.submissions.get(userId).submission,
            score: totalScore,
            votesReceived: contest.votes.get(userId)?.size || 0
        }))
        .sort((a, b) => b.score - a.score);

    broadcastToGroup(groupId, { type: 'contest_ended', results });

    // Store in history
    if (!contestHistory.has(groupId)) contestHistory.set(groupId, []);
    contestHistory.get(groupId).push({
        endedAt: Date.now(),
        creator: contest.creator,
        results: results.slice(0, 3), // Store top 3
        totalParticipants: contest.submissions.size
    });
    contests.delete(groupId);
}

// Helpers
function calculateScores(contest) {
    const scores = new Map();
    contest.submissions.forEach((_, userId) => scores.set(userId, 0));
    contest.votes.forEach((userVotes) => {
        userVotes.forEach((score, targetUserId) => {
            scores.set(targetUserId, scores.get(targetUserId) + score);
        });
    });
    return scores;
}

function broadcastToGroup(groupId, message, excludeWs = null) {
    const groupData = groups.get(groupId);
    groupData?.clients.forEach(client => {
        if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(message));
        }
    });
}

function broadcastVotingStart(groupId, contest) {
    broadcastToGroup(groupId, {
        type: 'voting_started',
        submissions: Array.from(contest.submissions.entries()).map(([user, data]) => ({
            userId: user,
            submission: data.submission
        })),
        votingDeadline: contest.votingDeadline
    });
}

function checkContestDeadlines(groupId, groupData) {
    const contest = contests.get(groupId);
    if (!contest) return;

    if (contest.status === 'submission' && Date.now() >= contest.submissionDeadline) {
        contest.status = 'voting';
        contest.votingDeadline = Date.now() + contest.votingDuration;
        broadcastVotingStart(groupId, contest);
    } else if (contest.status === 'voting' && Date.now() >= contest.votingDeadline) {
        endContest(groupId, groupData);
    }
}

function sendContestHistory(ws) {
    const history = contestHistory.get(ws.groupId) || [];
    ws.send(JSON.stringify({
        type: 'contest_history',
        history: history.slice(-5) // Last 5 contests
    }));
}

function handleAdminActions(ws, data) {
    if (!ws.isAdmin) return;
    const groupData = groups.get(ws.groupId);
    const targetWs = getClientById(ws.groupId, data.targetUserId);

    switch (data.type) {
        case 'promote_admin':
            if (targetWs) {
                groupData.admins.add(data.targetUserId);
                targetWs.isAdmin = true;
                broadcastToGroup(ws.groupId, { type: 'admin_promoted', userId: data.targetUserId });
            }
            break;
        case 'kick':
            if (targetWs && !targetWs.isAdmin) {
                targetWs.close(1008, 'You have been kicked');
                broadcastToGroup(ws.groupId, { type: 'user_kicked', userId: data.targetUserId, by: ws.userId });
            }
            break;
        case 'ban':
            if (targetWs && !targetWs.isAdmin) {
                groupData.banned.add(data.targetUserId);
                targetWs.close(1008, 'You have been banned');
                broadcastToGroup(ws.groupId, { type: 'user_banned', userId: data.targetUserId, by: ws.userId });
            }
            break;
    }
}

function getClientById(groupId, userId) {
    return Array.from(groups.get(groupId)?.clients || []).find(client => client.userId === userId);
}

function cleanupClient(ws) {
    const groupData = groups.get(ws.groupId);
    groupData.clients.delete(ws);
    if (groupData.clients.size === 0) {
        groups.delete(ws.groupId);
        contests.delete(ws.groupId);
    }
}

function checkRateLimit(userId) {
    const now = Date.now();
    let rl = rateLimits.get(userId);

    if (!rl || now - rl.lastReset > RATE_LIMIT.windowMs) {
        rl = { count: 0, lastReset: now };
        rateLimits.set(userId, rl);
    }

    rl.count++;
    return rl.count <= RATE_LIMIT.max;
}

function createGroup() {
    const groupId = uuidv4();
    const joinCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    groups.set(groupId, { clients: new Set(), admins: new Set(), banned: new Set() });
    groupCodes.set(joinCode, groupId);
    setTimeout(() => groupCodes.delete(joinCode), 24 * 60 * 60 * 1000);
    return { groupId, joinCode };
}

const { joinCode } = createGroup();
console.log(`New group created with join code: ${joinCode}`);

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`WebSocket server running on port ${PORT}`);
    console.log(`Sample join URL: ws://localhost:${PORT}/?code=${joinCode}&userId=yourUserId`);
});