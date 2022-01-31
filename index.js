const AWS = require("aws-sdk");
const request = require("request");
const mc = require("minecraft-protocol");

const ec2 = new AWS.EC2({ region: "us-east-1" });
const instanceId = process.env.INSTANCE_ID;
const webhookUrl = process.env.WEBHOOK_URL;
const dnsName = process.env.DNS_NAME;
const duckDnsToken = process.env.DUCK_DNS_TOKEN;

// The Lambda entry point.
exports.handler = (event, context, callback) => {
  console.log("instance id", instanceId);
  if (!instanceId) {
    return callback("no instance id set");
  }
  console.log("event", event);
  switch (event.resource) {
    case "/start":
      return startInstance(instanceId, cb);
    case "/stop":
      return stopInstance(instanceId, cb);
    case "/status":
      return getStatus(instanceId, cb);
    default:
      // The function is invoked every 15 minutes using a CloudWatch trigger with no event resource.
      // Since this is an automated call we want to log any errors instead of transforming them.
      return stopInstance(instanceId, callback);
  }

  // cb is a helper function that transforms errors to error messages, attaches helpful links, and also logs the response.
  function cb(err, data) {
    data = data ? data : {};

    let response = {
      statusCode: 200,
    };

    // Transform the error
    if (err) {
      response.statusCode = 500;
      data.error = err;
    }

    // Add useful links
    data.links = {
      start: getLink("start"),
      stop: getLink("stop"),
      status: getLink("status"),
    };

    // Add the data to the response body
    response.body = JSON.stringify(data);

    console.log("response:", response);
    return callback(null, response);
  }

  function getLink(path) {
    return (
      "https://" +
      event.headers.Host +
      "/" +
      event.requestContext.stage +
      "/" +
      path
    );
  }
};

function sendMessage(message, cb) {
  if (!webhookUrl) {
    console.error("no webhook url set");
    return;
  }
  request.post(
    {
      url: webhookUrl,
      json: true,
      body: {
        content: message,
      },
    },
    function (error, response, body) {
      if (cb == null) {
        if (error !== null) {
          console.log("failed to send message");
          console.log("error:", error); // Print the error if one occurred
          console.log("statusCode:", response && response.statusCode); // Print the response status code if a response was received
          console.log("body:", body); // Print the HTML for the Google homepage.
        }
        return;
      }
      cb(error, response, body);
    }
  );
}

// Gets the current status of both the EC2 instance and the Minecraft server running on it.
function getStatus(instanceId, cb) {
  getInstanceStatus(instanceId, function (err, instanceData) {
    if (err) return cb(err);

    const response = {
      instance: instanceData,
    };

    if (dnsName) {
      response.dnsName = `${dnsName}.duckdns.org`;
    }

    if (instanceData.state != "running") return cb(null, response);

    getMinecraftServerStatus(instanceData.ip, function (err, serverData) {
      if (err) return cb(err, response);
      response.minecraft = serverData;
      return cb(err, response);
    });
  });
}

// Starts the EC2 instance if it is stopped.
// Returns an error if the instance is not in the stopped state. Does not return an error if it is already running.
function startInstance(instanceId, cb) {
  getInstanceStatus(instanceId, function (err, instanceData) {
    if (err) return cb(err);
    if (instanceData.state == "running")
      return cb(null, { message: "instance is running" });
    if (instanceData.state != "stopped")
      return cb(
        `instance cannot be stopped in the ${instanceData.state} state`
      );
    ec2.startInstances({ InstanceIds: [instanceId] }, function (err, data) {
      if (err) {
        console.log(err, err.stack);
        return cb("failed to start instance");
      }

      setTimeout(() => {
        getInstanceStatus(instanceId, function (err, instanceData) {
          if (err) return cb(err);

          const ipAddress = instanceData.ip;
          if (!ipAddress) {
            sendMessage(
              `minecraft server starting - ⚠️ failed to update 🦆 dns; ip address unavailable ⚠️`
            );
            return cb(null, { message: "instance starting" });
          }

          updateDuckDns(ipAddress, (err, updated) => {
            if (err !== null || (!updated && dnsName)) {
              sendMessage(
                `minecraft server starting - ⚠️ failed to update 🦆 dns; ip is ${ipAddress} ⚠️`
              );
            } else {
              sendMessage("minecraft server starting");
            }
            return cb(null, { message: "instance starting" });
          });
        });
      }, 1000 * 5); // 5 seconds
    });
  });
}

// Stops the EC2 instance if it is running and there are no players online in the Minecraft server running on the instance. Does not return an error if it is already stopped.
function stopInstance(instanceId, cb) {
  getInstanceStatus(instanceId, function (err, instanceData) {
    if (err) return cb(err);
    if (instanceData.state == "stopped")
      return cb(null, { message: "instance is stopped" });
    if (instanceData.state != "running")
      return cb(
        `instance cannot be stopped in the ${instanceData.state} state`
      );

    getMinecraftServerStatus(instanceData.ip, function (err, serverData) {
      if (err) return cb(err);
      if (serverData.players.online != 0)
        return cb("instance cannot be stopped when players are online");

      ec2.stopInstances({ InstanceIds: [instanceId] }, function (err, data) {
        if (err) {
          console.log(err, err.stack);
          return cb("failed to stop instance");
        }
        sendMessage("minecraft server stopping");
        return cb(null, { message: "instance stopping" });
      });
    });
  });
}

// Gets the EC2 instance status.
function getInstanceStatus(instanceId, cb) {
  ec2.describeInstances({ InstanceIds: [instanceId] }, function (err, data) {
    if (err) {
      console.log(err, err.stack); // an error occurred
      return cb("failed to query status of instance");
    }

    let instance;
    try {
      instance = data.Reservations[0].Instances[0];
    } catch (e) {
      console.log(err, err.stack); // an error occurred
      return cb("failed to parse instance information");
    }

    return cb(null, {
      id: instance.InstanceId,
      state: instance.State.Name,
      ip: instance.PublicIpAddress,
    });
  });
}

// Gets the Minecraft server status.
function getMinecraftServerStatus(ip, cb) {
  mc.ping(
    {
      host: ip,
      port: 25565,
    },
    function (err, data) {
      if (err) {
        console.log(err, err.stack); // an error occurred
        return cb("failed to query status of minecraft server");
      }
      return cb(null, data);
    }
  );
}

// Updates the dns in duckdns.org.
function updateDuckDns(ip, cb) {
  if (!dnsName) {
    console.warn("no dns name set; not updating dynamic dns via 🦆 dns");
    return cb(null, false);
  }
  if (!duckDnsToken) {
    console.warn("no 🦆 dns token set; not updating dynamic dns via 🦆 dns");
    return cb(null, false);
  }
  console.log("setting dynamic dns via 🦆 dns; domain:", dnsName, "ip", ip);
  request.get(
    {
      url: `https://www.duckdns.org/update?domains=${dnsName}&token=${duckDnsToken}&ip=${ip}`,
    },
    function (error, response, body) {
      if (error !== null) {
        console.warn("failed to update 🦆 dns");
        console.warn("error:", error);
        console.warn("statusCode:", response && response.statusCode);
        console.warn("body:", body);
        return cb(error);
      }
      cb(null, true);
    }
  );
}
