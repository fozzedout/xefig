var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/worker.js
function log(message2) {
  console.log(message2);
}
__name(log, "log");
var worker_default = {
  async fetch(request, env, ctx) {
    
    if (request.method === "POST") {

      try {
        //console.log(await request.tee());
        var data = await request.json();

        if (!data.hasOwnProperty('name') || !data.hasOwnProperty('message'))
          return new Response("Invalid Structure", { status: 400});

        if (typeof data.name !== 'string' || typeof data.message !== 'string')
          return new Response("Invalid Data", { status: 400});

        if ( data.name === "" || data.message === "")
          return new Response("Empty Data", { status: 400});

        data.name = data.name.replace(/&/g, '+').replace(/</g, '≤');
        data.message = data.message.replace(/&/g, '+').replace(/</g, '≤');

        var insert = await env.DB
          .prepare("insert into messages (name, message, rating) values (?, ?, 1);")
          .bind(data.name, data.message)
          .run();

      } catch (error) {
        log("Error parsing request JSON: " + error);
        return new Response(error.toString(), { status: 500 });
      }
    }

    try {
      var dt = await env.DB.prepare("select * from messages order by id desc limit 30;").run();
      
      if ( dt.success === true)
        return Response.json(dt.results, { headers: { "Access-Control-Allow-Origin": "*" } });
    } catch (error) {
      console.error(error);
    }
    return Response.json([{"id":1, "name":"System", "message":"There is a problem with the database", "rank":1}]);

  }
};
export {
  worker_default as default
};
//# sourceMappingURL=worker.js.map
