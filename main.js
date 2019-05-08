#! /usr/bin/env node

process.env[ "NODE_PATH" ] = __dirname;
require( "module").Module._initPaths();

const util = require( "util" );
const Discord = require( "discord" );

const config = require( "./config" );

let client;
let server;
let channel;

let last_name = { };
let last_message = { };

let gametypes = { };
for( let gt in config.GAMETYPES ) {
	gametypes[ gt ] = { required: config.GAMETYPES[ gt ], added: [ ] };
};

let afkers;
let pending_gt;
let pending_game_unique;

// returns a unique value so we can compare with some reference to make sure it
// hasn't changed. used to e.g. halt the first set of afk checks if two games
// start right after each other
// implementation is trivial but give it a name for documentation purposes
function make_unique() {
	return { };
}

function unixtime() {
	return new Date().getTime() / 1000;
}

function say( fmt, ...args ) {
	if( typeof fmt == "object" ) {
		say( "%s", fmt.join( "\n" ) );
		return;
	}

	client.sendMessage( {
		to: channel,
		message: util.format( fmt, ...args ),
	} );
}

function update_channel_name() {
	let gametype = gametypes[ config.DEFAULT_GAMETYPE ];
	let wrestlers = String.fromCodePoint( 0x1f93c );
	let left_paren = "\uff08";
	let right_paren = "\uff09";
	let slash = "\uff89";
	client.editChannelInfo( {
		channelID: channel,
		name: util.format( "%spickup%s%d%s%d%s", wrestlers,
			left_paren, gametype.added.length, slash, gametype.required, right_paren ),
	} );
}

function get_name( id ) {
	let name = server.members[ id ] != null ? server.members[ id ].nick : null;
	return name != null ? name : last_name[ id ];
}

function pad_centred( str, width ) {
	let left = Math.floor( ( width - str.length ) / 2 );
	let right = width - str.length - left;
	return " ".repeat( left ) + str + " ".repeat( right );
}

function gametype_status( name ) {
	let gt = gametypes[ name ];
	let added = String( gt.added.length ).padStart( 2 );
	let required = String( gt.required ).padEnd( 2 );
	const names = gt.added.length == 0 ? "dead game" : gt.added.map( get_name ).join( ", " );
	return util.format( "%s/%s |%s| %s", added, required, pad_centred( name, 11 ), names );
}

function sorted_gametypes() {
	let sorted = [ ];
	for( let gt in gametypes ) {
		sorted.push( gt );
	}

	sorted.sort( ( a, b ) => gametypes[ a ].added.length < gametypes[ b ].added.length );

	return sorted;
}

function brief_status() {
	let gts = sorted_gametypes();
	gts = gts.map( gt => util.format( "%s [%d/%d]", gt, gametypes[ gt ].added.length, gametypes[ gt ].required ) );
	return gts.join( " - " );
}

function remove_player( gt, id ) {
	const idx = gametypes[ gt ].added.indexOf( id );
	if( idx != -1 ) {
		gametypes[ gt ].added.splice( idx, 1 );
		update_channel_name();
	}
	return idx != -1;
}

function remove_player_from_all( id ) {
	let was_added = false;
	for( let gt in gametypes ) {
		if( remove_player( gt, id ) )
			was_added = true;
	}
	return was_added;
}

function emoji_border( emoji, msg ) {
	msg.splice( 0, 0, emoji.repeat( 20 ) );
	msg.push( emoji.repeat( 20 ) );
	say( msg );
}

function copy_array( arr ) {
	return arr.slice();
}

function start_the_game() {
	const gg = "<:goodgame:" + config.GOODGAME_EMOJI + ">";
	emoji_border( gg, [
		"CONNECT TO THE SERVER: connect " + config.IP + ";password " + config.PASSWORD,
		"OR CLICK HERE: <https://cocainediesel.fun/connect?" + config.PASSWORD + "@" + config.IP + ">",
		gametypes[ pending_gt ].added.map( id => "<@" + id + ">" ).join( " " ),
	] );

	let added_copy = copy_array( gametypes[ pending_gt ].added );
	for( let id of added_copy ) {
		remove_player_from_all( id );
	}

	afkers = undefined;
	pending_gt = undefined;
	pending_game_unique = undefined;
}

function check_afk( attempt, unique ) {
	if( unique != pending_game_unique )
		return;

	if( afkers.length == 0 ) {
		start_the_game();
		return;
	}

	if( attempt == config.UNAFK_HIGHLIGHTS ) {
		afkers.forEach( id => remove_player_from_all( id ) );
		const cross = "\u274c";
		emoji_border( cross, [
			afkers.map( id => "<@" + id + ">" ).join( " " ) + " fucked it up for everyone",
			brief_status(),
		] );

		afkers = undefined;
		pending_gt = undefined;
		pending_game_unique = undefined;

		return;
	}

	const warning = "\u26a0";
	emoji_border( warning, [
		"Some people are AFK! Say something so we can start the game",
		afkers.map( id => "<@" + id + ">" ).join( " " ),
	] );

	setTimeout( () => check_afk( attempt + 1, unique ), config.UNAFK_DELAY * 1000 );
}

function unafk( channelID, messageID, userID ) {
	if( afkers == undefined )
		return;

	const idx = afkers.indexOf( userID );
	if( idx == -1 )
		return;

	afkers.splice( idx, 1 );

	client.addReaction( {
		channelID: channelID,
		messageID: messageID,
		reaction: String.fromCodePoint( 0x1f44d ),
	} );

	if( afkers.length == 0 ) {
		start_the_game();
	}
}

function words( str ) {
	return str.split( " " ).filter( word => word.length > 0 );
}

function match( re, str ) {
	const matches = re.exec( str );
	if( matches == undefined )
		return undefined;
	return matches[ 1 ];
}

function add_command( id, args ) {
	if( pending_game_unique != undefined )
		return;

	let gts = words( args );
	if( gts.length == 0 )
		gts = [ config.DEFAULT_GAMETYPE ];

	let did_add = false;
	for( let gt of gts ) {
		if( !( gt in gametypes ) )
			continue;

		if( gametypes[ gt ].added.includes( id ) )
			continue;

		gametypes[ gt ].added.push( id );
		did_add = true;

		if( gametypes[ gt ].added.length == gametypes[ gt ].required ) {
			const now = unixtime();
			afkers = gametypes[ gt ].added.filter( id => last_message[ id ] < now - config.AFK_TIME );
			pending_gt = gt;
			pending_game_unique = make_unique();
			check_afk( 1, pending_game_unique );
			return;
		}
	}

	if( did_add ) {
		say( "%s", brief_status() );
		update_channel_name();
	}
}

function remove_command( id, args ) {
	if( pending_game_unique != undefined )
		return;

	let was_added = false;

	let gts = words( args );
	if( gts.length == 0 ) {
		was_added = remove_player_from_all( id );
	}
	else {
		for( let gt of gts ) {
			if( !( gt in gametypes ) )
				continue;

			if( remove_player( gt, id ) )
				was_added = true;
		}
	}

	if( was_added )
		say( "%s", brief_status() );
}

function who_command() {
	let gts = sorted_gametypes().map( gametype_status );
	gts.splice( 0, 0, "```" );
	gts.push( "```" );
	say( gts );
}

const op_commands = {
	pickuphere: function() {
		console.log( "exports.PICKUP_CHANNEL = \"%s\";", channel );
	},

	opremove: function( id, args ) {
		if( pending_game_unique != undefined )
			return;

		const target = match( /<@(\d+)>/, args );
		if( target ) {
			let was_added = remove_player_from_all( target );
			if( was_added )
				say( "%s", brief_status() );
			else
				say( "they aren't added" );
		}
	},
};

const normal_commands = [
	{ pattern: /^!add\s*(.*)/, callback: add_command },
	{ pattern: /^\+\+/, callback: add_command },
	{ pattern: /^\+(.+)/, callback: add_command },

	{ pattern: /^!remove\s*(.*)/, callback: remove_command },
	{ pattern: /^--/, callback: remove_command },
	{ pattern: /^-(.+)/, callback: remove_command },

	{ pattern: /^!who/, callback: who_command },
	{ pattern: /^\?\?/, callback: who_command },
];

function try_commands( cmds, user, channel, message ) {
	const space_pos = message.indexOf( " " );
	const cmd = space_pos == -1 ? message : message.substr( 0, space_pos );
	const rest = space_pos == -1 ? "" : message.substr( space_pos ).trim();

	if( cmds[ cmd ] ) {
		cmds[ cmd ]( user, rest );
		return true;
	}

	return false;
}

let offline_uniques = { };

function remove_offline( user, userID, unique ) {
	if( unique != offline_uniques[ userID ] )
		return;

	if( remove_player_from_all( userID ) ) {
		say( [
			user + " went offline and was removed",
			brief_status(),
		] );
	}
}

function on_ready() {
	for( const server_id in client.servers ) {
		server = client.servers[ server_id ];
		break;
	}

	if( config.OP_ROLE == undefined || config.OP_ROLE == "" ) {
		console.log( "You need to set OP_ROLE" );
		for( const role_id in server.roles ) {
			const role = server.roles[ role_id ];
			console.log( "Role %s: exports.OP_ROLE = \"%s\";", role.name, role_id );
		}
		process.exit( 1 )
	}

	console.log( "Connected" );
}

function on_message( user, userID, channelID, message, e ) {
	last_name[ userID ] = user;
	last_message[ userID ] = unixtime();

	unafk( channelID, e.d.id, userID );

	if( config.PICKUP_CHANNEL != undefined && channelID != config.PICKUP_CHANNEL )
		return;

	channel = channelID;

	if( userID == client.id )
		return;

	message = message.toLowerCase();

	if( message[ 0 ] == '!' ) {
		const is_op = e.d.member.roles.includes( config.OP_ROLE );
		if( is_op && try_commands( op_commands, userID, channelID, message.substr( 1 ) ) )
			return;
	}

	for( let cmd of normal_commands ) {
		let e = cmd.pattern.exec( message );
		if( e == null )
			continue;
		cmd.callback( userID, e[ 1 ] || "" );
	}
}

function on_presence( user, userID, status ) {
	if( status == "online" ) {
		offline_uniques[ userID ] = undefined;
	}

	if( status == "offline" ) {
		// mark them as AFK and remove them if they don't come back
		last_message[ userID ] = unixtime() - config.AFK_TIME - 1;
		const unique = make_unique();
		offline_uniques[ userID ] = unique;
		setTimeout( () => remove_offline( user, userID, unique ), config.OFFLINE_DELAY * 1000 );
	}
}

function on_guildMemberRemove( member ) {
	if( remove_player_from_all( member.id ) ) {
		say( [
			member.username + " left the server and was removed",
			brief_status(),
		] );
	}
}

function connect() {
	client = new Discord.Client( {
		autorun: true,
		token: config.TOKEN,
	} );

	client.on( "ready", on_ready );
	client.on( "message", on_message );
	client.on( "presence", on_presence );
	client.on( "guildMemberRemove", on_guildMemberRemove );
	client.on( "disconnect", connect );
}

connect();
