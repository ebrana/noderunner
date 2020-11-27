db.createCollection('history');
db.createCollection('planned');
db.createCollection('immediate');

db.planned.insertOne(
    {
        "command" : "sleep 80",
        "job" : "sleep 80 dsadasddasdd dasdassd sdadadsd asdasdass asdadasdasds asdasdas dd dasdadasdda dasadasdaas dasdasdasdasdas asddasdada",
        "host" : "test.cz",
        "schedule" : "*/2 * * * *",
        "status" : "planed",
        "tags" : [
            "tag1"
        ]
    }
)

db.createUser(
    {
        user: "test",
        pwd: "test",
        roles: [
            {
                role: "readWrite",
                db: "noderuner"
            }
        ]
    }
);